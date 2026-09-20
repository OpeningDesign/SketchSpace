/**
 * Live template values from Bonsai.
 *
 * Bonsai runs a small socket.io server (`bim/data/webui/sioserver.py`) that
 * Blender connects to as `/blender` and web pages as `/web`. This joins as a web
 * client, asks each connected Blender for its sheet template values
 * (`sourcePage: "sheets"`, `getTemplateValues`), and hands the answers to
 * `ifcValues`, where they take precedence over the saved file - they include
 * edits not yet saved.
 *
 * It needs a Bonsai with the `sheets` handler; one without simply never
 * answers, which is logged once, and the saved file keeps being used.
 *
 * Bonsai's server records its port in `running_pid.json` beside itself and does
 * not always remove it, so every listed port is tried and dead ones are left
 * alone for a while. The server binds to 127.0.0.1: this only ever reaches a
 * Blender on the same machine as SketchSpace.
 *
 * Edits go back the same way (`askToSetValues`) - to Bonsai, never to the file.
 * Blender holds the model in memory, so a write to the `.ifc` would be invisible
 * to it and lost on its next save, and renaming a sheet or drawing moves files
 * and relinks layouts, which only Bonsai does.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { io, type Socket } from "socket.io-client";

import { config } from "./config.js";
import { setLiveValues, type IfcExtract } from "./ifcValues.js";

/** How often each connected Blender is asked. Blender answers within a second. */
const POLL_MS = 3000;
/** How often running_pid.json is re-read for servers started since. */
const DISCOVER_MS = 10_000;
/** A port that refused a connection is not tried again for this long. */
const DEAD_PORT_MS = 30_000;
/** A Blender that has not answered for this long no longer speaks for its model. */
const SILENCE_MS = 15_000;
/** Unanswered requests before saying this Bonsai cannot answer at all. */
const UNANSWERED_BEFORE_WARNING = 3;

type Blender = {
  id: string;
  lastAnswer: number;
  unanswered: number;
  warned: boolean;
};

type Connection = {
  port: number;
  socket: Socket;
  blenders: Map<string, Blender>;
};

const connections = new Map<number, Connection>();
const deadUntil = new Map<number, number>();

const sourceOf = (port: number, blenderId: string) => `${port}/${blenderId}`;

/**
 * Where Bonsai keeps `running_pid.json`: its package's `bim/data/webui`, in
 * each Blender version's user directory - as an extension or a legacy add-on.
 * Links are followed, so a development checkout is found through them.
 */
const webuiDirs = (): string[] => {
  if (config.bonsaiWebuiDirs.length > 0) {
    return config.bonsaiWebuiDirs;
  }

  const home = os.homedir();
  const roots =
    process.platform === "win32"
      ? [path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Blender Foundation", "Blender")]
      : process.platform === "darwin"
        ? [path.join(home, "Library", "Application Support", "Blender")]
        : [path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "blender")];

  const found = new Set<string>();
  const list = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const root of roots) {
    for (const version of list(root)) {
      const base = path.join(root, version);
      const packages = [
        path.join(base, "scripts", "addons"),
        ...list(path.join(base, "extensions", ".local", "lib")).map((python) =>
          path.join(base, "extensions", ".local", "lib", python, "site-packages"),
        ),
      ];
      for (const pkg of packages) {
        const webui = path.join(pkg, "bonsai", "bim", "data", "webui");
        if (existsSync(webui)) {
          try {
            found.add(realpathSync(webui));
          } catch {
            found.add(webui);
          }
        }
      }
    }
  }
  return [...found];
};

const listedPorts = (): number[] => {
  const ports = new Set<number>();
  for (const dir of webuiDirs()) {
    try {
      const pids = JSON.parse(readFileSync(path.join(dir, "running_pid.json"), "utf8")) as Record<
        string,
        unknown
      >;
      for (const port of Object.values(pids)) {
        if (Number.isInteger(port)) {
          ports.add(port as number);
        }
      }
    } catch {
      // No file, or one being rewritten: try again next round.
    }
  }
  return [...ports];
};

const isExtract = (value: unknown): value is IfcExtract =>
  !!value &&
  typeof value === "object" &&
  typeof (value as IfcExtract).ifc === "string" &&
  Array.isArray((value as IfcExtract).sheets) &&
  typeof (value as IfcExtract).north === "object";

const forget = (connection: Connection, blenderId: string) => {
  connection.blenders.delete(blenderId);
  setLiveValues(sourceOf(connection.port, blenderId), null);
};

const connect = (port: number) => {
  const socket = io(`http://127.0.0.1:${port}/web`, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 3000,
  });
  const connection: Connection = { port, socket, blenders: new Map() };
  connections.set(port, connection);

  const addBlender = (id: unknown) => {
    if (typeof id === "string" && !connection.blenders.has(id)) {
      connection.blenders.set(id, { id, lastAnswer: Date.now(), unanswered: 0, warned: false });
    }
  };

  socket.on("connect", () => {
    console.log(`[sketchspace] connected to Bonsai's web server on port ${port}`);
  });
  socket.on("connect_error", () => {
    deadUntil.set(port, Date.now() + DEAD_PORT_MS);
    socket.close();
    connections.delete(port);
  });
  socket.on("disconnect", () => {
    for (const id of [...connection.blenders.keys()]) {
      forget(connection, id);
    }
    connections.delete(port);
    console.log(`[sketchspace] Bonsai's web server on port ${port} went away`);
  });

  socket.on("connected_clients", (ids: unknown) => {
    if (Array.isArray(ids)) {
      ids.forEach(addBlender);
    }
  });
  socket.on("blender_connect", addBlender);
  socket.on("blender_disconnect", (id: unknown) => {
    if (typeof id === "string") {
      forget(connection, id);
    }
  });

  socket.on("sheet_template_values", (message: unknown) => {
    const { blenderId, data } = (message ?? {}) as { blenderId?: unknown; data?: unknown };
    if (typeof blenderId !== "string") {
      return;
    }
    addBlender(blenderId);
    const blender = connection.blenders.get(blenderId)!;
    blender.lastAnswer = Date.now();
    blender.unanswered = 0;
    blender.warned = false;

    const values = (data as { template_values?: unknown } | undefined)?.template_values;
    if (!isExtract(values)) {
      return;
    }
    // A model never saved has no path to match layouts against.
    setLiveValues(sourceOf(port, blenderId), values.ifc ? values : null);
  });

  socket.on("sheet_edit_result", (message: unknown) => {
    const { blenderId, data } = (message ?? {}) as { blenderId?: unknown; data?: unknown };
    const answer = (data as { edit_result?: EditResult } | undefined)?.edit_result;
    if (typeof blenderId !== "string" || !answer) {
      return;
    }
    const blender = connection.blenders.get(blenderId);
    if (blender) {
      blender.lastAnswer = Date.now();
      blender.unanswered = 0;
    }
    settle(answer);
  });
};

type EditResult = {
  requestId?: string;
  ok?: boolean;
  error?: string;
  fields?: EditableField[];
  changed?: string[];
  /** Where the sheet's layout is after the edit; it moves when a sheet is renamed. */
  layout?: string;
  kind?: string;
};

/** One field of a view-title or titleblock, as Bonsai reports it. */
export type EditableField = {
  name: string;
  value: string;
  editable: boolean;
  /** Why not, when it cannot be edited - shown as it is given. */
  reason?: string;
};

/**
 * A Blender that has been asked something and has not answered yet.
 *
 * Every other message here is state being broadcast; these are replies to one
 * caller, matched by the id the request carried. A Blender busy in a modal
 * operator answers nothing at all, so a request that is never answered has to
 * end by itself rather than leave someone waiting on a spinner.
 */
const REQUEST_TIMEOUT_MS = 10_000;
const pending = new Map<string, { settle: (result: EditResult) => void; timer: NodeJS.Timeout }>();

const settle = (answer: EditResult) => {
  const waiting = answer.requestId ? pending.get(answer.requestId) : undefined;
  if (waiting) {
    pending.delete(answer.requestId!);
    clearTimeout(waiting.timer);
    waiting.settle(answer);
  }
};

const ask = (source: string, operator: Record<string, unknown>): Promise<EditResult> => {
  const split = source.indexOf("/");
  const port = Number(source.slice(0, split));
  const blenderId = source.slice(split + 1);
  const connection = connections.get(port);
  if (!connection?.socket.connected || !connection.blenders.has(blenderId)) {
    return Promise.reject(new Error("Blender is no longer connected"));
  }

  const requestId = randomUUID();
  return new Promise<EditResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Blender did not answer - it may be busy"));
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    pending.set(requestId, {
      timer,
      settle: (answer) =>
        answer.ok === false
          ? reject(new Error(answer.error || "Bonsai refused the edit"))
          : resolve(answer),
    });
    connection.socket.emit("web_operator", {
      blenderId,
      sourcePage: "sheets",
      operator: { ...operator, requestId },
    });
  });
};

/**
 * What a view's template fields hold, and which of them Bonsai can write.
 *
 * `fields` are the placeholders the template actually uses, so the answer covers
 * what is on the sheet rather than every attribute of the entity behind it.
 * Editability is Bonsai's to decide - it owns the operations that would apply a
 * change, and deciding here would drift from what it accepts.
 */
export const askEditableFields = async (
  source: string,
  layout: string,
  target: Record<string, unknown>,
  fields: string[],
): Promise<EditableField[]> => {
  const answer = await ask(source, { type: "getEditableFields", layout, target, fields });
  return answer.fields ?? [];
};

/**
 * Apply values to the model Blender has open.
 *
 * Answers with the fields that changed and where the sheet's layout is now:
 * renaming a sheet moves it, so the path the caller asked about is already
 * gone, and only Bonsai knows the new one without going looking.
 */
export const askToSetValues = async (
  source: string,
  layout: string,
  target: Record<string, unknown>,
  values: Record<string, string>,
): Promise<{ changed: string[]; layout: string }> => {
  const answer = await ask(source, { type: "setTemplateValue", layout, target, values });
  return { changed: answer.changed ?? [], layout: answer.layout || layout };
};

const poll = () => {
  const now = Date.now();
  for (const connection of connections.values()) {
    if (!connection.socket.connected) {
      continue;
    }
    for (const blender of [...connection.blenders.values()]) {
      if (now - blender.lastAnswer > SILENCE_MS) {
        // Hung, or busy for a long time: its last answer may no longer be true.
        setLiveValues(sourceOf(connection.port, blender.id), null);
      }
      blender.unanswered++;
      if (blender.unanswered > UNANSWERED_BEFORE_WARNING && !blender.warned) {
        blender.warned = true;
        console.warn(
          `[sketchspace] Blender ${blender.id} on port ${connection.port} is not answering ` +
            `sheet template requests - it may be busy, or its Bonsai has no "sheets" handler. ` +
            `Saved-file values are used meanwhile.`,
        );
      }
      connection.socket.emit("web_operator", {
        blenderId: blender.id,
        sourcePage: "sheets",
        operator: { type: "getTemplateValues", requestId: randomUUID() },
      });
    }
  }
};

const discover = () => {
  const now = Date.now();
  for (const port of listedPorts()) {
    if (connections.has(port) || (deadUntil.get(port) ?? 0) > now) {
      continue;
    }
    connect(port);
  }
};

/** Start looking for Bonsai. Returns a function that stops and forgets it all. */
export const startBonsaiBridge = (): (() => void) => {
  if (!config.bonsaiBridge) {
    return () => {};
  }
  discover();
  const discovering = setInterval(discover, DISCOVER_MS);
  const polling = setInterval(poll, POLL_MS);
  discovering.unref();
  polling.unref();

  return () => {
    clearInterval(discovering);
    clearInterval(polling);
    for (const connection of connections.values()) {
      for (const id of [...connection.blenders.keys()]) {
        forget(connection, id);
      }
      connection.socket.close();
    }
    connections.clear();
  };
};
