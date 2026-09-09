/**
 * Watch imported Bonsai layouts and pull changes in.
 *
 * Bonsai rewrites the layout whenever a drawing or document is added or removed,
 * and whenever a regenerated drawing changes size (the reflow in
 * update_sheet_drawing_sizes). Without watching, those never reach SketchSpace -
 * and worse, a stale baseline here would silently revert Bonsai's reflow the
 * next time positions were written back.
 *
 * Echo suppression matters: our own writes land in the same file and would
 * otherwise bounce straight back as an external change.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";

import { db, deletePage, renamePage } from "./db.js";
import {
  addSheetToBoard,
  boundPages,
  drawingGuidSet,
  normalisePath,
  resolveLayouts,
  sheetName,
} from "./layoutImport.js";
import { parseLayout } from "./bonsaiLayout.js";
import { rebindLayoutPath, syncPageWithLayout } from "./layoutSync.js";
import { applyUpdate, getElements } from "./store.js";

import type { SyncElement } from "./types.js";

/** Coalesce editor save flurries, and keep Dropbox churn down. */
const DEBOUNCE_MS = 1500;
/** How often to notice layouts belonging to newly imported boards. */
const RESCAN_MS = 30_000;

const watchers = new Map<string, FSWatcher>();
const dirWatchers = new Map<string, FSWatcher>();
/**
 * Directories holding the files a layout *links to* - drawings, titleblocks,
 * view-title assets - mapped to the layouts that reference them.
 *
 * Editing one of those does not touch the layout, and they live in
 * subdirectories (`layouts/titleblocks`) or siblings (`drawings`) that a
 * non-recursive watch on the layouts directory cannot see. Without this, a
 * redrawn titleblock simply never appears.
 */
const assetWatchers = new Map<string, FSWatcher>();
const assetDirLayouts = new Map<string, Set<string>>();
const timers = new Map<string, NodeJS.Timeout>();

/**
 * Content hashes of what we last wrote ourselves. The watcher ignores a change
 * whose content matches - otherwise every push would trigger a re-sync of the
 * file we just authored.
 */
const selfWritten = new Map<string, string>();

export const noteSelfWrite = (layoutPath: string, content: string): void => {
  selfWritten.set(layoutPath, createHash("sha256").update(content).digest("hex"));
};

type PageRef = { pageId: string; boardId: string };

/** Which pages reference which layout, discovered from stored scene data. */
const scanLayouts = (): Map<string, PageRef[]> => {
  const found = new Map<string, PageRef[]>();
  const rows = db
    .prepare(
      `SELECT ps.page_id AS pageId, p.board_id AS boardId, ps.elements AS elements
       FROM page_scenes ps
       JOIN pages p ON p.id = ps.page_id AND p.deleted = 0
       WHERE ps.elements LIKE '%"bonsai"%'`,
    )
    .all() as { pageId: string; boardId: string; elements: string }[];

  for (const row of rows) {
    let elements: SyncElement[];
    try {
      elements = JSON.parse(row.elements) as SyncElement[];
    } catch {
      continue;
    }
    const paths = new Set<string>();
    for (const el of elements) {
      const layout = (
        el.customData as { bonsai?: { layout?: string } } | undefined
      )?.bonsai?.layout;
      if (layout) {
        paths.add(layout);
      }
    }
    for (const layoutPath of paths) {
      const list = found.get(layoutPath);
      const ref = { pageId: row.pageId, boardId: row.boardId };
      if (list) {
        list.push(ref);
      } else {
        found.set(layoutPath, [ref]);
      }
    }
  }
  return found;
};

type Broadcast = (pageId: string, elements: SyncElement[]) => void;
/** Announce that a board's page list changed - added, renamed or removed tab. */
type BroadcastPages = (boardId: string) => void;

const syncLayout = (layoutPath: string, broadcast: Broadcast): void => {
  if (!existsSync(layoutPath)) {
    return;
  }

  let content: string;
  try {
    content = readFileSync(layoutPath, "utf8");
  } catch {
    return; // mid-write; the next event will catch it
  }

  const hash = createHash("sha256").update(content).digest("hex");
  if (selfWritten.get(layoutPath) === hash) {
    return; // our own write echoing back
  }
  selfWritten.set(layoutPath, hash);

  for (const { pageId, boardId } of scanLayouts().get(layoutPath) ?? []) {
    try {
      const summary = syncPageWithLayout(getElements(pageId), boardId, layoutPath);
      if (summary.changed.length === 0) {
        continue;
      }
      const accepted = applyUpdate(pageId, summary.changed);
      if (accepted.length > 0) {
        broadcast(pageId, accepted);
      }
      console.log(
        `[sketchspace] layout sync ${layoutPath}: ` +
          `+${summary.added} ~${summary.updated} -${summary.removed}`,
      );
    } catch (error) {
      console.error(`[sketchspace] layout sync failed for ${pageId}:`, error);
    }
  }
};

/**
 * Re-sync a layout because one of its *linked files* changed.
 *
 * `syncLayout` short-circuits when the layout's own content hash is unchanged,
 * which it is here - the titleblock moved, not the sheet. `syncPageWithLayout`
 * re-hashes every linked file, so simply running it picks the new bytes up.
 */
const resyncLayoutAssets = (layoutPath: string, broadcast: Broadcast): void => {
  for (const { pageId, boardId } of scanLayouts().get(layoutPath) ?? []) {
    try {
      const summary = syncPageWithLayout(getElements(pageId), boardId, layoutPath);
      if (summary.changed.length === 0) {
        continue;
      }
      const accepted = applyUpdate(pageId, summary.changed);
      if (accepted.length > 0) {
        broadcast(pageId, accepted);
      }
      console.log(
        `[sketchspace] linked asset changed for ${path.basename(layoutPath)}: ` +
          `~${summary.updated} placement(s) refreshed`,
      );
    } catch (error) {
      console.error(`[sketchspace] asset resync failed for ${pageId}:`, error);
    }
  }
};

/** Directories containing the files this layout links to. */
const assetDirsOf = (layoutPath: string): string[] => {
  try {
    return [
      ...new Set(
        parseLayout(layoutPath).placements.map((p) => path.dirname(p.href)),
      ),
    ];
  } catch {
    return [];
  }
};

/**
 * Reconcile a whole layouts directory against the board that covers it.
 *
 * Watching individual files is not enough. Bonsai renames the layout file when a
 * sheet is renamed and creates a new one when a sheet is added, and neither
 * event reaches a watcher bound to the old path. Without this, a rename orphans
 * the old tab and duplicates it, and a new sheet never appears at all.
 *
 * A layout carries no identity of its own, so a rename is recognised by its set
 * of drawing GlobalIds matching a page whose own file has disappeared.
 */
const reconcileDirectory = (
  layoutsDir: string,
  broadcast: Broadcast,
  broadcastPages: BroadcastPages,
): void => {
  let files: string[];
  try {
    files = resolveLayouts(layoutsDir).files;
  } catch {
    return;
  }

  // boundPages() reads the database, which lags the in-memory store by the
  // persistence debounce. Take each page's live layout path from the store, or a
  // rebind we just made looks un-done and gets applied again on the next pass.
  const livePath = (pageId: string, fallback: string): string => {
    for (const el of getElements(pageId)) {
      const layout = (
        el.customData as { bonsai?: { layout?: string } } | undefined
      )?.bonsai?.layout;
      if (layout) {
        return layout;
      }
    }
    return fallback;
  };

  const pagesHere = boundPages()
    .map((p) => ({ ...p, layoutPath: livePath(p.pageId, p.layoutPath) }))
    .filter(
      (p) => normalisePath(path.dirname(p.layoutPath)) === normalisePath(layoutsDir),
    );

  // A directory that suddenly has no layouts at all is far more likely to be a
  // disconnected drive or a sync hiccup than every sheet being deleted. Do
  // nothing rather than tear a board down.
  if (files.length === 0 && pagesHere.length > 0) {
    console.warn(
      `[sketchspace] ${layoutsDir} has no layouts but ${pagesHere.length} tab(s) ` +
        `reference it - leaving them alone`,
    );
    return;
  }
  if (pagesHere.length === 0) {
    return; // no board covers this directory
  }
  const boardId = pagesHere[0]!.boardId;
  const bound = new Set(pagesHere.map((p) => normalisePath(p.layoutPath)));

  let pagesChanged = false;

  for (const file of files) {
    if (bound.has(normalisePath(file))) {
      continue;
    }

    const guids = drawingGuidSet(file);
    const renamed = pagesHere.find(
      (p) =>
        p.boardId === boardId &&
        !existsSync(p.layoutPath) &&
        guids.length > 0 &&
        guids.length === p.guids.length &&
        guids.every((g, i) => g === p.guids[i]),
    );

    if (renamed) {
      const changed = rebindLayoutPath(
        getElements(renamed.pageId),
        renamed.layoutPath,
        file,
      );
      const accepted = applyUpdate(renamed.pageId, changed);
      renamePage(renamed.pageId, sheetName(file));
      if (accepted.length > 0) {
        broadcast(renamed.pageId, accepted);
      }
      bound.add(normalisePath(file));
      pagesChanged = true;
      console.log(
        `[sketchspace] sheet renamed: "${renamed.pageName}" -> "${sheetName(file)}"`,
      );
      continue;
    }

    const page = addSheetToBoard(boardId, file);
    bound.add(normalisePath(file));
    pagesChanged = true;
    console.log(`[sketchspace] new sheet: "${page.name}"`);
  }

  /*
   * Pages whose layout file has vanished - the sheet was deleted in Bonsai, or
   * renamed in a way we could not match.
   *
   * Remove the tab unless it carries something the user drew. A deleted sheet
   * should not leave a tab behind, but redlines are the one thing here that
   * exists nowhere else, so a tab holding any is kept and reported instead.
   *
   * Deletion is a soft delete, so even a wrong call is recoverable from the
   * database rather than destructive.
   */
  for (const p of pagesHere) {
    if (existsSync(p.layoutPath)) {
      continue;
    }

    const ownWork = getElements(p.pageId).some(
      (el) =>
        !el.isDeleted &&
        !(el.customData as { bonsai?: unknown } | undefined)?.bonsai,
    );

    if (ownWork) {
      console.warn(
        `[sketchspace] "${p.pageName}" has lost its layout ` +
          `(${path.basename(p.layoutPath)}) but carries your own drawing, so it is kept`,
      );
      continue;
    }

    deletePage(p.pageId);
    pagesChanged = true;
    console.log(
      `[sketchspace] removed tab "${p.pageName}" - its sheet is gone from Bonsai`,
    );
  }

  if (pagesChanged) {
    broadcastPages(boardId);
  }
};

const schedule = (layoutPath: string, broadcast: Broadcast): void => {
  clearTimeout(timers.get(layoutPath));
  timers.set(
    layoutPath,
    setTimeout(() => {
      timers.delete(layoutPath);
      syncLayout(layoutPath, broadcast);
    }, DEBOUNCE_MS),
  );
};

const refreshWatches = (
  broadcast: Broadcast,
  broadcastPages: BroadcastPages,
): void => {
  const wanted = scanLayouts();

  for (const [layoutPath, watcher] of watchers) {
    if (!wanted.has(layoutPath)) {
      watcher.close();
      watchers.delete(layoutPath);
    }
  }

  // Watch each layouts directory too, so renames and additions are noticed.
  for (const layoutPath of wanted.keys()) {
    const dir = path.dirname(layoutPath);
    if (dirWatchers.has(dir) || !existsSync(dir)) {
      continue;
    }
    try {
      let timer: NodeJS.Timeout | undefined;
      const watcher = watch(dir, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          reconcileDirectory(dir, broadcast, broadcastPages);
          refreshWatches(broadcast, broadcastPages);
        }, DEBOUNCE_MS);
      });
      watcher.on("error", () => {
        watcher.close();
        dirWatchers.delete(dir);
      });
      dirWatchers.set(dir, watcher);
      console.log(`[sketchspace] watching layouts dir ${dir}`);
      // Reconcile once on adoption. A directory can arrive already out of step -
      // a board imported by a script while we were not watching it, or sheets
      // renamed between the import and the next rescan.
      reconcileDirectory(dir, broadcast, broadcastPages);
    } catch (error) {
      console.error(`[sketchspace] cannot watch ${dir}:`, error);
    }
  }

  // Watch the directories holding each layout's linked files.
  for (const layoutPath of wanted.keys()) {
    for (const dir of assetDirsOf(layoutPath)) {
      const set = assetDirLayouts.get(dir) ?? new Set<string>();
      set.add(layoutPath);
      assetDirLayouts.set(dir, set);

      if (assetWatchers.has(dir) || dirWatchers.has(dir) || !existsSync(dir)) {
        continue;
      }
      try {
        let timer: NodeJS.Timeout | undefined;
        const watcher = watch(dir, () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            for (const lp of assetDirLayouts.get(dir) ?? []) {
              resyncLayoutAssets(lp, broadcast);
            }
          }, DEBOUNCE_MS);
        });
        watcher.on("error", () => {
          watcher.close();
          assetWatchers.delete(dir);
        });
        assetWatchers.set(dir, watcher);
        console.log(`[sketchspace] watching assets dir ${dir}`);
      } catch (error) {
        console.error(`[sketchspace] cannot watch ${dir}:`, error);
      }
    }
  }

  for (const layoutPath of wanted.keys()) {
    if (watchers.has(layoutPath) || !existsSync(layoutPath)) {
      continue;
    }
    try {
      // Seed the hash so an unchanged file on boot is not treated as a change.
      selfWritten.set(
        layoutPath,
        createHash("sha256").update(readFileSync(layoutPath, "utf8")).digest("hex"),
      );
      const watcher = watch(layoutPath, () => schedule(layoutPath, broadcast));
      watcher.on("error", () => {
        watcher.close();
        watchers.delete(layoutPath);
      });
      watchers.set(layoutPath, watcher);
      console.log(`[sketchspace] watching layout ${layoutPath}`);
    } catch (error) {
      console.error(`[sketchspace] cannot watch ${layoutPath}:`, error);
    }
  }
};

export const startLayoutWatcher = (
  broadcast: Broadcast,
  broadcastPages: BroadcastPages,
): (() => void) => {
  refreshWatches(broadcast, broadcastPages);

  // Catch up on anything that changed while we were not running: sheets added,
  // renamed, or removed in Bonsai between sessions.
  for (const dir of [...dirWatchers.keys()]) {
    try {
      reconcileDirectory(dir, broadcast, broadcastPages);
    } catch (error) {
      console.error(`[sketchspace] startup reconcile failed for ${dir}:`, error);
    }
  }
  const rescan = setInterval(
    () => refreshWatches(broadcast, broadcastPages),
    RESCAN_MS,
  );
  rescan.unref();

  return () => {
    clearInterval(rescan);
    for (const w of watchers.values()) {
      w.close();
    }
    for (const w of dirWatchers.values()) {
      w.close();
    }
    for (const w of assetWatchers.values()) {
      w.close();
    }
    watchers.clear();
    dirWatchers.clear();
    assetWatchers.clear();
    assetDirLayouts.clear();
  };
};
