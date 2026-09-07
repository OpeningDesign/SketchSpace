/**
 * Importing Bonsai sheet sets, shared by `scripts/import-sheets.mjs` (explicit)
 * and `scripts/open-layout.mjs` (on demand, from Blender's "open layout"
 * button).
 *
 * The model: **one board per IFC file, one page per sheet.** A drawing set is a
 * board; each sheet is a tab.
 *
 * All placement work goes through `syncPageWithLayout`, the same function the
 * layout watcher uses, so a freshly imported page and a re-synced one are built
 * by one implementation.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  createBoard,
  createPage,
  listPages,
  renamePage,
  saveSceneJSON,
  db,
} from "./db.js";
import { parseLayout } from "./bonsaiLayout.js";
import { syncPageWithLayout } from "./layoutSync.js";

import type { Board, Page } from "./types.js";

/** Windows hands back either slash and any case; compare normalised. */
export const normalisePath = (p: string): string =>
  path.resolve(p).replace(/\\/g, "/").toLowerCase();

export const sheetName = (layoutPath: string): string =>
  path.basename(layoutPath, path.extname(layoutPath));

/** Resolve a project dir, a layouts dir, or a single .svg into sheet files. */
export const resolveLayouts = (
  input: string,
): { dir: string; files: string[] } => {
  const target = path.resolve(input);
  if (statSync(target).isFile()) {
    return { dir: path.dirname(target), files: [target] };
  }
  const dir = existsSync(path.join(target, "layouts"))
    ? path.join(target, "layouts")
    : target;
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".svg"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => path.join(dir, f));
  return { dir, files };
};

/**
 * Board identity comes from the IFC file beside `layouts/` - Bonsai resolves
 * every drawing path relative to that file's directory, so it is the natural
 * unit. Prefer one whose name appears in the path when a project holds several.
 */
export const deriveBoardName = (layoutsDir: string): string => {
  const projectDir = path.dirname(layoutsDir);
  const ifcs = existsSync(projectDir)
    ? readdirSync(projectDir).filter((f) => f.toLowerCase().endsWith(".ifc"))
    : [];
  if (ifcs.length > 0) {
    const normalised = projectDir.replace(/\\/g, "/").toLowerCase();
    const preferred =
      ifcs.find((f) =>
        normalised.includes(path.basename(f, ".ifc").toLowerCase()),
      ) ?? ifcs.sort()[0]!;
    return path.basename(preferred, ".ifc");
  }
  return path.basename(projectDir);
};

type SceneRow = {
  pageId: string;
  boardId: string;
  pageName: string;
  boardName: string;
  elements: string;
};

const scenesWithBonsai = (): SceneRow[] =>
  db
    .prepare(
      `SELECT ps.page_id AS pageId, p.board_id AS boardId, p.name AS pageName,
              b.name AS boardName, ps.elements AS elements
       FROM page_scenes ps
       JOIN pages p  ON p.id = ps.page_id AND p.deleted = 0
       JOIN boards b ON b.id = p.board_id
       WHERE ps.elements LIKE '%"bonsai"%'`,
    )
    .all() as SceneRow[];

const layoutsOf = (row: SceneRow): string[] => {
  try {
    return (JSON.parse(row.elements) as { customData?: { bonsai?: { layout?: string } } }[])
      .map((el) => el.customData?.bonsai?.layout)
      .filter((l): l is string => Boolean(l));
  } catch {
    return [];
  }
};

/** Which page, if any, already holds this exact layout file. */
export const findPageForLayout = (
  layoutPath: string,
): { boardId: string; pageId: string; boardName: string; pageName: string } | null => {
  const wanted = normalisePath(layoutPath);
  for (const row of scenesWithBonsai()) {
    if (layoutsOf(row).some((l) => normalisePath(l) === wanted)) {
      return {
        boardId: row.boardId,
        pageId: row.pageId,
        boardName: row.boardName,
        pageName: row.pageName,
      };
    }
  }
  return null;
};

/** Which board, if any, already covers this layouts directory. */
export const findBoardForLayoutsDir = (
  layoutsDir: string,
): { boardId: string; boardName: string } | null => {
  const wanted = normalisePath(layoutsDir);
  for (const row of scenesWithBonsai()) {
    if (layoutsOf(row).some((l) => normalisePath(path.dirname(l)) === wanted)) {
      return { boardId: row.boardId, boardName: row.boardName };
    }
  }
  return null;
};

/** Add one sheet to an existing board as a new tab. */
export const addSheetToBoard = (boardId: string, layoutPath: string): Page => {
  const page = createPage(boardId, sheetName(layoutPath), null);
  const summary = syncPageWithLayout([], boardId, layoutPath);
  saveSceneJSON(page.id, JSON.stringify(summary.changed));
  return page;
};

export type ImportedSheet = { page: Page; layoutPath: string; placements: number };

/**
 * Create a board for a sheet set, one page per sheet.
 * Safe to run against a live server: every page here is new, so nothing the
 * server has cached in memory can overwrite it.
 */
export const importSheetSet = (
  layoutsDir: string,
  files: string[],
  boardName?: string,
): { board: Board; sheets: ImportedSheet[] } => {
  const created = createBoard(boardName ?? deriveBoardName(layoutsDir));
  const sheets: ImportedSheet[] = [];

  files.forEach((file, i) => {
    // createBoard already made a page; reuse it for the first sheet rather than
    // leaving an empty "Page 1" behind.
    let page: Page;
    if (i === 0) {
      page = created.page;
      renamePage(page.id, sheetName(file));
      page = { ...page, name: sheetName(file) };
    } else {
      page = createPage(created.board.id, sheetName(file), null);
    }

    const summary = syncPageWithLayout([], created.board.id, file);
    saveSceneJSON(page.id, JSON.stringify(summary.changed));
    sheets.push({ page, layoutPath: file, placements: summary.added });
  });

  return { board: created.board, sheets };
};

/** Pages already on a board, for reporting. */
export const boardPageCount = (boardId: string): number =>
  listPages(boardId).length;


/* ---------------------------- sheet identity ----------------------------- */

/**
 * A layout SVG records no identity of its own - the root <svg> carries only
 * `id="root"`. The stable thing it *does* carry is the set of IFC GlobalIds of
 * the drawings placed on it (`data-drawing`), which survives the file being
 * renamed.
 *
 * That matters because Bonsai renames the layout file when a sheet is renamed.
 * Matching on path alone treats the rename as a brand new sheet: the old tab is
 * orphaned and a duplicate appears.
 */
export const drawingGuidSet = (layoutPath: string): string[] => {
  try {
    return [
      ...new Set(
        parseLayout(layoutPath)
          .placements.map((p) => p.globalId)
          .filter((g): g is string => Boolean(g)),
      ),
    ].sort();
  } catch {
    return [];
  }
};

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);

export type BoundPage = {
  boardId: string;
  pageId: string;
  pageName: string;
  layoutPath: string;
  guids: string[];
};

/** Every page currently bound to a Bonsai layout, with its drawing GlobalIds. */
export const boundPages = (): BoundPage[] => {
  const out: BoundPage[] = [];
  for (const row of scenesWithBonsai()) {
    let elements: {
      customData?: { bonsai?: { layout?: string; globalId?: string | null } };
    }[];
    try {
      elements = JSON.parse(row.elements);
    } catch {
      continue;
    }
    const byLayout = new Map<string, Set<string>>();
    for (const el of elements) {
      const b = el.customData?.bonsai;
      if (!b?.layout) {
        continue;
      }
      const set = byLayout.get(b.layout) ?? new Set<string>();
      if (b.globalId) {
        set.add(b.globalId);
      }
      byLayout.set(b.layout, set);
    }
    for (const [layoutPath, guids] of byLayout) {
      out.push({
        boardId: row.boardId,
        pageId: row.pageId,
        pageName: row.pageName,
        layoutPath,
        guids: [...guids].sort(),
      });
    }
  }
  return out;
};

/**
 * A page whose layout file has disappeared but whose drawing set matches this
 * one - i.e. the sheet was renamed in Bonsai rather than replaced.
 */
export const findRenamedPage = (
  layoutPath: string,
  guids: string[],
): BoundPage | null => {
  if (guids.length === 0) {
    return null;
  }
  const wanted = normalisePath(layoutPath);
  for (const page of boundPages()) {
    if (normalisePath(page.layoutPath) === wanted) {
      continue;
    }
    if (!existsSync(page.layoutPath) && sameSet(guids, page.guids)) {
      return page;
    }
  }
  return null;
};
