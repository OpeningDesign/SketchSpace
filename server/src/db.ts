import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { config } from "./config.js";
import { firstIndex, indexBetween } from "./fracIndex.js";

import type { Board, Page } from "./types.js";

const ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const newId = (length = 12): string => {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  }
  return out;
};

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(path.join(config.dataDir, "files"), { recursive: true });

export const db = new Database(path.join(config.dataDir, "sketchspace.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pages (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    frac_index  TEXT NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pages_board
    ON pages (board_id, deleted, frac_index);

  CREATE TABLE IF NOT EXISTS page_scenes (
    page_id     TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    elements    TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    mime_type   TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
`);

type BoardRow = {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
};

type PageRow = {
  id: string;
  board_id: string;
  name: string;
  frac_index: string;
  created_at: number;
  updated_at: number;
};

const toBoard = (r: BoardRow): Board => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toPage = (r: PageRow): Page => ({
  id: r.id,
  boardId: r.board_id,
  name: r.name,
  fracIndex: r.frac_index,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const stmts = {
  listBoards: db.prepare(`SELECT * FROM boards ORDER BY updated_at DESC`),
  getBoard: db.prepare(`SELECT * FROM boards WHERE id = ?`),
  insertBoard: db.prepare(
    `INSERT INTO boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ),
  touchBoard: db.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`),
  renameBoard: db.prepare(
    `UPDATE boards SET name = ?, updated_at = ? WHERE id = ?`,
  ),
  deleteBoard: db.prepare(`DELETE FROM boards WHERE id = ?`),

  listPages: db.prepare(
    `SELECT * FROM pages WHERE board_id = ? AND deleted = 0 ORDER BY frac_index, id`,
  ),
  getPage: db.prepare(`SELECT * FROM pages WHERE id = ? AND deleted = 0`),
  countPages: db.prepare(
    `SELECT COUNT(*) AS n FROM pages WHERE board_id = ? AND deleted = 0`,
  ),
  insertPage: db.prepare(
    `INSERT INTO pages (id, board_id, name, frac_index, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ),
  renamePage: db.prepare(
    `UPDATE pages SET name = ?, updated_at = ? WHERE id = ?`,
  ),
  reindexPage: db.prepare(
    `UPDATE pages SET frac_index = ?, updated_at = ? WHERE id = ?`,
  ),
  softDeletePage: db.prepare(
    `UPDATE pages SET deleted = 1, updated_at = ? WHERE id = ?`,
  ),

  getScene: db.prepare(`SELECT elements FROM page_scenes WHERE page_id = ?`),
  upsertScene: db.prepare(
    `INSERT INTO page_scenes (page_id, elements, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(page_id) DO UPDATE SET
       elements = excluded.elements,
       updated_at = excluded.updated_at`,
  ),

  insertFile: db.prepare(
    `INSERT INTO files (id, board_id, mime_type, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ),
  getFile: db.prepare(
    `SELECT id, mime_type FROM files WHERE id = ? AND board_id = ?`,
  ),
};

export const listBoards = (): Board[] =>
  (stmts.listBoards.all() as BoardRow[]).map(toBoard);

export const getBoard = (id: string): Board | null => {
  const row = stmts.getBoard.get(id) as BoardRow | undefined;
  return row ? toBoard(row) : null;
};

/** Creates a board together with its first page, atomically. */
export const createBoard = (name: string): { board: Board; page: Page } => {
  const now = Date.now();
  const boardId = newId();
  const pageId = newId();
  const fracIndex = firstIndex();

  db.transaction(() => {
    stmts.insertBoard.run(boardId, name, now, now);
    stmts.insertPage.run(pageId, boardId, "Page 1", fracIndex, now, now);
    stmts.upsertScene.run(pageId, "[]", now);
  })();

  return {
    board: { id: boardId, name, createdAt: now, updatedAt: now },
    page: {
      id: pageId,
      boardId,
      name: "Page 1",
      fracIndex,
      createdAt: now,
      updatedAt: now,
    },
  };
};

export const renameBoard = (id: string, name: string): void => {
  stmts.renameBoard.run(name, Date.now(), id);
};

export const deleteBoard = (id: string): void => {
  stmts.deleteBoard.run(id);
};

export const touchBoard = (id: string): void => {
  stmts.touchBoard.run(Date.now(), id);
};

export const listPages = (boardId: string): Page[] =>
  (stmts.listPages.all(boardId) as PageRow[]).map(toPage);

export const getPage = (id: string): Page | null => {
  const row = stmts.getPage.get(id) as PageRow | undefined;
  return row ? toPage(row) : null;
};

/**
 * Creates a page positioned immediately after `afterPageId`, or at the end of
 * the board when it is null.
 */
export const createPage = (
  boardId: string,
  name: string | null,
  afterPageId: string | null,
): Page => {
  const pages = listPages(boardId);
  const afterIdx = afterPageId
    ? pages.findIndex((p) => p.id === afterPageId)
    : pages.length - 1;

  const lowerBound = afterIdx >= 0 ? (pages[afterIdx]?.fracIndex ?? null) : null;
  const upperBound =
    afterIdx >= 0 ? (pages[afterIdx + 1]?.fracIndex ?? null) : null;

  const now = Date.now();
  const id = newId();
  const fracIndex = indexBetween(lowerBound, upperBound);
  const count = (stmts.countPages.get(boardId) as { n: number }).n;
  const pageName = name?.trim() || `Page ${count + 1}`;

  db.transaction(() => {
    stmts.insertPage.run(id, boardId, pageName, fracIndex, now, now);
    stmts.upsertScene.run(id, "[]", now);
    stmts.touchBoard.run(now, boardId);
  })();

  return {
    id,
    boardId,
    name: pageName,
    fracIndex,
    createdAt: now,
    updatedAt: now,
  };
};

export const renamePage = (id: string, name: string): void => {
  stmts.renamePage.run(name, Date.now(), id);
};

/**
 * Moves a page to sit between the two given neighbours. Both bounds are page
 * ids; null means the corresponding end of the list.
 */
export const movePage = (
  pageId: string,
  afterPageId: string | null,
  beforePageId: string | null,
): void => {
  const after = afterPageId ? getPage(afterPageId) : null;
  const before = beforePageId ? getPage(beforePageId) : null;
  const fracIndex = indexBetween(
    after?.fracIndex ?? null,
    before?.fracIndex ?? null,
  );
  stmts.reindexPage.run(fracIndex, Date.now(), pageId);
};

/** Soft delete, so a page open in someone else's tab degrades gracefully. */
export const deletePage = (id: string): void => {
  stmts.softDeletePage.run(Date.now(), id);
};

export const loadSceneJSON = (pageId: string): string => {
  const row = stmts.getScene.get(pageId) as { elements: string } | undefined;
  return row?.elements ?? "[]";
};

export const saveSceneJSON = (pageId: string, json: string): void => {
  stmts.upsertScene.run(pageId, json, Date.now());
};

export const recordFile = (
  id: string,
  boardId: string,
  mimeType: string,
): void => {
  stmts.insertFile.run(id, boardId, mimeType, Date.now());
};

export const findFile = (
  id: string,
  boardId: string,
): { id: string; mime_type: string } | null =>
  (stmts.getFile.get(id, boardId) as { id: string; mime_type: string }) ?? null;
