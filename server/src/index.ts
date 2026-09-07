import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { Server } from "socket.io";

import {
  checkPassword,
  clearCookie,
  isAuthed,
  issueToken,
  requireAuth,
  sessionCookie,
} from "./auth.js";
import {
  assetUrl,
  decodeDataURL,
  migrateDataUrlAssets,
  readAsset,
  writeAsset,
} from "./assets.js";
import { pageRoom, registerCollab } from "./collab.js";
import { config } from "./config.js";
import {
  createBoard,
  deleteBoard,
  findFile,
  getBoard,
  listBoards,
  listPages,
  recordFile,
  renameBoard,
} from "./db.js";
import { flushLayoutAutosaves, pushBoardToLayouts } from "./layoutWriter.js";
import { startLayoutWatcher } from "./layoutWatcher.js";
import { flushAll } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "../client");

const app = express();
app.disable("x-powered-by");
// Images arrive as data URLs inside JSON, so the default 100kb limit is far
// too small.
app.use(express.json({ limit: "64mb" }));

/* ---------------------------------- auth --------------------------------- */

app.post("/api/login", (req, res) => {
  if (!checkPassword(req.body?.password)) {
    res.status(401).json({ error: "wrong password" });
    return;
  }
  res.setHeader("Set-Cookie", sessionCookie(issueToken()));
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", clearCookie());
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  res.json({ authed: isAuthed(req) });
});

/* --------------------------------- boards -------------------------------- */

app.get("/api/boards", requireAuth, (_req, res) => {
  res.json({ boards: listBoards() });
});

app.post("/api/boards", requireAuth, (req, res) => {
  const name =
    typeof req.body?.name === "string" && req.body.name.trim()
      ? req.body.name.trim().slice(0, 120)
      : "Untitled board";
  res.json(createBoard(name));
});

app.get<{ boardId: string }>("/api/boards/:boardId", requireAuth, (req, res) => {
  const board = getBoard(req.params.boardId);
  if (!board) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ board, pages: listPages(board.id) });
});

app.patch<{ boardId: string }>("/api/boards/:boardId", requireAuth, (req, res) => {
  if (!getBoard(req.params.boardId)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (typeof req.body?.name === "string" && req.body.name.trim()) {
    renameBoard(req.params.boardId, req.body.name.trim().slice(0, 120));
  }
  res.json({ ok: true });
});

app.delete<{ boardId: string }>("/api/boards/:boardId", requireAuth, (req, res) => {
  deleteBoard(req.params.boardId);
  res.json({ ok: true });
});

/* --------------------------------- files --------------------------------- */

/**
 * Assets are stored as raw bytes and served from here, not embedded as data
 * URLs in JSON. See server/src/assets.ts for why.
 */
app.post<{ boardId: string }>("/api/boards/:boardId/files", requireAuth, (req, res) => {
  const { boardId } = req.params;
  if (!getBoard(boardId)) {
    res.status(404).json({ error: "not found" });
    return;
  }

  const { id, mimeType, dataURL } = req.body ?? {};
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(id) ||
    typeof mimeType !== "string" ||
    typeof dataURL !== "string"
  ) {
    res.status(400).json({ error: "bad request" });
    return;
  }

  // The editor hands us a data URL; store the bytes it carries.
  const decoded = decodeDataURL(dataURL);
  if (!decoded) {
    res.status(400).json({ error: "expected a data URL" });
    return;
  }

  writeAsset(boardId, id, decoded.bytes);
  recordFile(id, boardId, mimeType || decoded.mimeType);
  res.json({ ok: true });
});

/**
 * Metadata only. `dataURL` is a same-origin URL rather than the bytes, so the
 * response stays small and the browser fetches and caches each asset itself.
 */
app.get<{ boardId: string }>("/api/boards/:boardId/files", requireAuth, (req, res) => {
  const { boardId } = req.params;
  const ids = String(req.query.ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_-]{1,255}$/.test(s));

  const files = [];
  for (const id of ids) {
    const record = findFile(id, boardId);
    if (!record) {
      continue;
    }
    files.push({
      id,
      mimeType: record.mime_type,
      dataURL: assetUrl(boardId, id),
      created: Date.now(),
    });
  }
  res.json({ files });
});

/**
 * The bytes. Ids are content hashes, so a response can be cached forever -
 * which is what stops a title block shared by fourteen sheets being refetched
 * fourteen times.
 */
app.get<{ boardId: string; fileId: string }>(
  "/api/boards/:boardId/assets/:fileId",
  requireAuth,
  (req, res) => {
    const { boardId, fileId } = req.params;
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(fileId)) {
      res.status(400).end();
      return;
    }
    const record = findFile(fileId, boardId);
    if (!record) {
      res.status(404).end();
      return;
    }
    try {
      const bytes = readAsset(boardId, fileId);
      res.setHeader("Content-Type", record.mime_type);
      // Private: the asset is behind the instance password.
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.setHeader("ETag", `"${fileId}"`);
      res.send(bytes);
    } catch {
      res.status(404).end();
    }
  },
);

/* --------------------------------- bonsai -------------------------------- */

/**
 * Write drawing positions back into the board's Bonsai layout.
 *
 * POST with {dryRun: true} to preview: the response lists what would move, in
 * millimetres, without touching a file. This writes into the user's project
 * repository, so the UI always previews first and asks before committing to it.
 */
app.post<{ boardId: string }>(
  "/api/boards/:boardId/push-layout",
  requireAuth,
  (req, res) => {
    const { boardId } = req.params;
    if (!getBoard(boardId)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const dryRun = req.body?.dryRun !== false;
    try {
      res.json(pushBoardToLayouts(boardId, !dryRun));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

/* --------------------------------- client -------------------------------- */

if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  // SPA fallback: anything that is not an API route serves the app shell.
  app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

/* --------------------------------- server -------------------------------- */

// Assets used to be stored as data URL text; rewrite any that still are.
migrateDataUrlAssets();

const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 64 * 1024 * 1024,
});

registerCollab(io);

// Pull in changes Bonsai makes to imported layouts - drawings added or removed,
// and the reflow that follows a regenerated drawing changing size.
const stopLayoutWatcher = startLayoutWatcher((pageId, elements) => {
  io.to(pageRoom(pageId)).emit("scene:patch", { pageId, elements });
});

httpServer.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `\n[sketchspace] port ${config.port} is already in use.\n\n` +
        `  Something else is listening - most likely an older sketchspace.\n` +
        `  Find and stop it:\n\n` +
        `    Get-NetTCPConnection -LocalPort ${config.port} -State Listen |\n` +
        `      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n\n` +
        `  Or run on a different port:  PORT=3001 npm start\n`,
    );
    process.exit(1);
  }
  throw error;
});

httpServer.listen(config.port, () => {
  console.log(`[sketchspace] listening on http://localhost:${config.port}`);
  console.log(`[sketchspace] data directory: ${path.resolve(config.dataDir)}`);
});

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[sketchspace] ${signal} received, flushing scenes...`);
  stopLayoutWatcher();
  flushLayoutAutosaves();
  flushAll();
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
  // Don't hang forever on a stuck socket.
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
