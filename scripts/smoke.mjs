/**
 * End-to-end smoke test for the collaboration path.
 *
 * Drives two concurrent socket clients against a running server and asserts
 * that scene deltas, page operations, presence, and persistence all work.
 *
 *   SKETCHSPACE_PASSWORD=dev PORT=3111 SKETCHSPACE_DATA_DIR=./tmp-smoke \
 *     node dist/server/index.js &
 *   node scripts/smoke.mjs http://localhost:3111 dev
 */
import { io } from "socket.io-client";

const BASE = process.argv[2] ?? "http://localhost:3111";
const PASSWORD = process.argv[3] ?? "dev";

let failures = 0;

const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) {
    failures++;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for one event, or reject on timeout. */
const waitFor = (socket, event, predicate = () => true, ms = 4000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, ms);
    const handler = (payload) => {
      if (!predicate(payload)) {
        return;
      }
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });

const ask = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 5000);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      if (response?.error) {
        reject(new Error(`${event}: ${response.error}`));
        return;
      }
      resolve(response);
    });
  });

const connect = (cookie) =>
  new Promise((resolve, reject) => {
    const socket = io(BASE, {
      transports: ["websocket"],
      extraHeaders: { Cookie: cookie },
    });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });

const element = (id, version, extra = {}) => ({
  id,
  type: "rectangle",
  version,
  versionNonce: 1000 + version,
  index: "a1",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  isDeleted: false,
  ...extra,
});

const main = async () => {
  console.log(`\nSketchSpace smoke test against ${BASE}\n`);

  /* ---------------------------------- auth -------------------------------- */

  const badLogin = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "definitely-wrong" }),
  });
  check("wrong password is rejected", badLogin.status === 401);

  const unauth = await fetch(`${BASE}/api/boards`);
  check("boards API requires auth", unauth.status === 401);

  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  check("correct password is accepted", login.ok);

  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  check("session cookie issued", Boolean(cookie));

  /* --------------------------------- board -------------------------------- */

  const created = await fetch(`${BASE}/api/boards`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: "Smoke board" }),
  }).then((r) => r.json());

  const boardId = created.board.id;
  check("board created with a first page", Boolean(boardId && created.page?.id));

  /* ------------------------------ two clients ----------------------------- */

  const alice = await connect(cookie);
  const bob = await connect(cookie);
  check("two clients connected", alice.connected && bob.connected);

  alice.emit("user:name", "Alice");
  bob.emit("user:name", "Bob");

  const aliceJoin = await ask(alice, "board:join", boardId);
  const bobJoin = await ask(bob, "board:join", boardId);
  check("both joined the board", aliceJoin.pages.length === 1 && bobJoin.pages.length === 1);

  const pageId = aliceJoin.pages[0].id;
  await ask(alice, "page:open", pageId);
  await ask(bob, "page:open", pageId);

  /* ---------------------------- scene broadcast --------------------------- */

  const patchPromise = waitFor(bob, "scene:patch", (p) => p.pageId === pageId);
  alice.emit("scene:push", { pageId, elements: [element("el-1", 1)] });
  const patch = await patchPromise;
  check(
    "Alice's element reaches Bob",
    patch.elements.length === 1 && patch.elements[0].id === "el-1",
  );

  /* --------------------------- conflict resolution ------------------------ */

  // A stale write (lower version) must be rejected outright: no rebroadcast.
  let sawStale = false;
  const staleListener = () => {
    sawStale = true;
  };
  bob.on("scene:patch", staleListener);
  alice.emit("scene:push", { pageId, elements: [element("el-1", 1)] });
  await sleep(400);
  bob.off("scene:patch", staleListener);
  check("stale write (same version) is discarded", !sawStale);

  const winPromise = waitFor(bob, "scene:patch");
  alice.emit("scene:push", { pageId, elements: [element("el-1", 5)] });
  const win = await winPromise;
  check("higher version wins", win.elements[0].version === 5);

  /* -------------------------- page isolation ------------------------------ */

  const pagesPromise = waitFor(bob, "pages:update", (p) => p.pages.length === 2);
  const { page: second } = await ask(alice, "page:create", {
    boardId,
    afterPageId: pageId,
  });
  const pagesUpdate = await pagesPromise;
  check("new page is announced to everyone", pagesUpdate.pages.length === 2);

  // Alice moves to page 2. Bob stays on page 1 and must hear nothing.
  await ask(alice, "page:open", second.id);

  let leaked = false;
  const leakListener = () => {
    leaked = true;
  };
  bob.on("scene:patch", leakListener);
  alice.emit("scene:push", {
    pageId: second.id,
    elements: [element("el-2", 1)],
  });
  await sleep(500);
  bob.off("scene:patch", leakListener);
  check("page 2 traffic does not leak to a page 1 viewer", !leaked);

  /* -------------------------------- presence ------------------------------ */

  const carol = await connect(cookie);
  carol.emit("user:name", "Carol");

  // Register the listener first, then trigger the event it is waiting for.
  const presencePromise = waitFor(bob, "presence", (p) => p.users.length === 3);
  await ask(carol, "board:join", boardId);
  const presenceAfterJoin = await presencePromise;

  check(
    "presence tracks everyone on the board",
    presenceAfterJoin.users.length === 3,
    presenceAfterJoin.users.map((u) => u.username).join(", "),
  );
  check(
    "presence reports which page each person is on",
    presenceAfterJoin.users.some((u) => u.pageId === second.id) &&
      presenceAfterJoin.users.some((u) => u.pageId === pageId),
  );


  /* ------------------------------ persistence ----------------------------- */

  // Longer than the 1s persist debounce.
  await sleep(1600);

  const fresh = await connect(cookie);
  await ask(fresh, "board:join", boardId);
  const reopened = await ask(fresh, "page:open", pageId);
  const survivor = reopened.elements.find((el) => el.id === "el-1");
  check(
    "element survives a fresh client opening the page",
    survivor?.version === 5,
  );

  const reopenedTwo = await ask(fresh, "page:open", second.id);
  check(
    "each page keeps its own elements",
    reopenedTwo.elements.length === 1 &&
      reopenedTwo.elements[0].id === "el-2" &&
      !reopenedTwo.elements.some((el) => el.id === "el-1"),
  );

  /* ------------------------------ page delete ----------------------------- */

  const deletePromise = waitFor(bob, "pages:update", (p) => p.pages.length === 1);
  alice.emit("page:delete", { pageId: second.id });
  await deletePromise;
  check("page delete propagates", true);

  const guard = await ask(fresh, "board:join", boardId);
  alice.emit("page:delete", { pageId: guard.pages[0].id });
  await sleep(400);
  const stillThere = await ask(fresh, "board:join", boardId);
  check("the last page cannot be deleted", stillThere.pages.length === 1);

  for (const socket of [alice, bob, carol, fresh]) {
    socket.disconnect();
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} - ${failures} failing check(s)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error("\nsmoke test crashed:", err.message, "\n");
  process.exit(1);
});
