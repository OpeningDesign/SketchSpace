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

import { db, deletePage, listPages, renamePage } from "./db.js";
import {
  addSheetToBoard,
  boundPages,
  drawingGuidSet,
  normalisePath,
  resolveLayouts,
  sheetName,
} from "./layoutImport.js";
import { parseLayout } from "./bonsaiLayout.js";
import { onLayoutValuesChanged, primeLayoutValues } from "./ifcValues.js";
import { drawingSizesChanged, rebindLayoutPath, syncPageWithLayout } from "./layoutSync.js";
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
/** Pages already reported as kept despite a missing layout. */
const keptWarned = new Set<string>();

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

  // A readable file is not necessarily a complete one. Bonsai (and Inkscape)
  // truncate the layout and write it again, so a watcher event can land on a
  // half-written file - which still reads fine, still parses, and yields fewer
  // placements than it should. Treated as real, that silently deletes every
  // drawing on the sheet. Requiring the closing tag costs nothing and the next
  // event brings the finished file.
  if (!/<\/svg\s*>\s*$/.test(content)) {
    return;
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
 * Re-sync a layout whose *inputs* changed while the layout itself did not: a
 * linked file (a redrawn titleblock), or the model values its templates show.
 *
 * `syncLayout` short-circuits when the layout's own content hash is unchanged,
 * which it is here. `syncPageWithLayout` re-renders and re-hashes every linked
 * file, so simply running it picks the change up.
 */
const resyncLayoutAssets = (
  layoutPath: string,
  broadcast: Broadcast,
  reason = "linked asset changed",
  templatesOnly = false,
): void => {
  // Renamed or deleted a moment ago: the directory reconcile deals with that,
  // and there is nothing here to re-render.
  if (!existsSync(layoutPath)) {
    return;
  }
  for (const { pageId, boardId } of scanLayouts().get(layoutPath) ?? []) {
    try {
      const summary = syncPageWithLayout(getElements(pageId), boardId, layoutPath, {
        templatesOnly,
      });
      if (summary.changed.length === 0) {
        continue;
      }
      const accepted = applyUpdate(pageId, summary.changed);
      if (accepted.length > 0) {
        broadcast(pageId, accepted);
      }
      console.log(
        `[sketchspace] ${reason} for ${path.basename(layoutPath)}: ` +
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

  // A page's identity is the set of drawings it *currently* places - so read
  // from the store, and leave out placements already deleted. Counting a drawing
  // removed from the sheet earlier made the page's set differ from its own
  // renamed layout, and the rename was taken for a delete plus a new sheet.
  const liveGuids = (pageId: string, layoutPath: string): string[] => {
    const guids = new Set<string>();
    for (const el of getElements(pageId)) {
      const b = (el.customData as { bonsai?: { layout?: string; globalId?: string | null } } | undefined)
        ?.bonsai;
      if (!el.isDeleted && b?.layout === layoutPath && b.globalId) {
        guids.add(b.globalId);
      }
    }
    return [...guids].sort();
  };

  const pagesHere = boundPages()
    .map((p) => {
      const layoutPath = livePath(p.pageId, p.layoutPath);
      return { ...p, layoutPath, guids: liveGuids(p.pageId, layoutPath) };
    })
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

  const newFiles = files.filter((file) => !bound.has(normalisePath(file)));
  const vanished = pagesHere.filter(
    (p) => p.boardId === boardId && !existsSync(p.layoutPath),
  );
  // Pages accounted for in this pass. The removal step below must skip them:
  // it once went on to delete the very tab it had just renamed, because its
  // list still held the page's old, now-missing layout path.
  const rebound = new Set<string>();

  const rebind = (page: (typeof vanished)[number], file: string, how: string) => {
    const changed = rebindLayoutPath(getElements(page.pageId), page.layoutPath, file);
    const accepted = applyUpdate(page.pageId, changed);
    renamePage(page.pageId, sheetName(file));
    if (accepted.length > 0) {
      broadcast(page.pageId, accepted);
    }
    // Then catch up with the renamed file itself: it may hold an edit made just
    // before the rename, and the watcher adopting it will take its current
    // content as already seen.
    const caughtUp = applyUpdate(
      page.pageId,
      syncPageWithLayout(getElements(page.pageId), page.boardId, file).changed,
    );
    if (caughtUp.length > 0) {
      broadcast(page.pageId, caughtUp);
    }
    rebound.add(page.pageId);
    bound.add(normalisePath(file));
    pagesChanged = true;
    console.log(
      `[sketchspace] sheet renamed: "${page.pageName}" -> "${sheetName(file)}" (${how})`,
    );
  };

  // 1. A renamed sheet places the same drawings as the page it was.
  const unmatched: { file: string; guids: string[] }[] = [];
  for (const file of newFiles) {
    const guids = drawingGuidSet(file);
    const page = vanished.find(
      (p) =>
        !rebound.has(p.pageId) &&
        guids.length > 0 &&
        guids.length === p.guids.length &&
        guids.every((g, i) => g === p.guids[i]),
    );
    if (page) {
      rebind(page, file, "same drawings");
    } else {
      unmatched.push({ file, guids });
    }
  }

  // 2. Otherwise, the sheet number - the "A01" in "A01 - NAME.svg", which a
  //    change of name keeps - together with the drawings, when they cannot
  //    match exactly:
  //    - a sheet with no drawings has nothing else to be recognised by;
  //    - a sheet edited just before its rename (a drawing removed, say) has
  //      drawings we have not caught up with yet, since the edit landed in the
  //      file we can no longer read. Sharing a drawing and a number is enough.
  //    Only an unambiguous pair counts: one such page, one such file.
  const sheetNumber = (layoutPath: string) => sheetName(layoutPath).split(" - ")[0]!.trim();
  const related = (a: readonly string[], b: readonly string[]) =>
    a.length === 0 && b.length === 0 ? "same sheet number, no drawings"
    : a.some((g) => b.includes(g)) ? "same sheet number, shared drawings"
    : null;
  const leftover: string[] = [];
  for (const { file, guids } of unmatched) {
    const number = sheetNumber(file);
    const candidates = vanished.filter(
      (p) =>
        !rebound.has(p.pageId) &&
        sheetNumber(p.layoutPath) === number &&
        related(p.guids, guids) !== null,
    );
    const rivals = unmatched.filter((u) => sheetNumber(u.file) === number);
    if (candidates.length === 1 && rivals.length === 1) {
      rebind(candidates[0]!, file, related(candidates[0]!.guids, guids)!);
      continue;
    }
    leftover.push(file);
  }

  // 3. Anything still unmatched is a new sheet.
  for (const file of leftover) {
    const page = addSheetToBoard(boardId, file);
    bound.add(normalisePath(file));
    pagesChanged = true;
    console.log(`[sketchspace] new sheet: "${page.name}"`);
  }

  /*
   * 4. Pages whose layout file has vanished and that nothing above claimed - the
   * sheet was deleted in Bonsai, or renamed in a way we could not match.
   *
   * Remove the tab unless it carries something the user drew. A deleted sheet
   * should not leave a tab behind, but redlines are the one thing here that
   * exists nowhere else, so a tab holding any is kept and reported instead.
   *
   * Deletion is a soft delete, so even a wrong call is recoverable from the
   * database rather than destructive.
   */
  for (const p of vanished) {
    if (rebound.has(p.pageId)) {
      continue;
    }

    if (hasOwnWork(p.pageId)) {
      // Once per page: this runs on every pass, and said so dozens of times.
      if (!keptWarned.has(p.pageId)) {
        keptWarned.add(p.pageId);
        console.warn(
          `[sketchspace] "${p.pageName}" has lost its layout ` +
            `(${path.basename(p.layoutPath)}) but carries your own drawing, so it is kept`,
        );
      }
      continue;
    }

    deletePage(p.pageId);
    pagesChanged = true;
    console.log(
      `[sketchspace] removed tab "${p.pageName}" - its sheet is gone from Bonsai`,
    );
  }

  /*
   * 5. Two live tabs on one layout. The CLI Bonsai launches can add a sheet in
   * the moment before this pass renames an existing tab onto the same file -
   * which `open_layout` makes likely, since it moves a file and launches the
   * CLI straight after. Keep one: a tab holding the user's own drawing, else
   * the first in tab order. Only duplicates with nothing of the user's on them
   * are removed; if several have, all stay and that is reported.
   */
  const order = new Map(listPages(boardId).map((page, i) => [page.id, i]));
  const byLayout = new Map<string, { pageId: string; pageName: string; file: string }[]>();
  for (const p of boundPages()) {
    const layoutPath = livePath(p.pageId, p.layoutPath);
    if (p.boardId !== boardId || !order.has(p.pageId)) {
      continue;
    }
    if (normalisePath(path.dirname(layoutPath)) !== normalisePath(layoutsDir)) {
      continue;
    }
    const key = normalisePath(layoutPath);
    const group = byLayout.get(key) ?? [];
    if (!group.some((g) => g.pageId === p.pageId)) {
      group.push({ pageId: p.pageId, pageName: p.pageName, file: path.basename(layoutPath) });
    }
    byLayout.set(key, group);
  }
  for (const group of byLayout.values()) {
    if (group.length < 2) {
      continue;
    }
    const ranked = group
      .map((g) => ({ ...g, own: hasOwnWork(g.pageId) }))
      .sort((a, b) => Number(b.own) - Number(a.own) || order.get(a.pageId)! - order.get(b.pageId)!);
    const [kept, ...rest] = ranked;
    for (const extra of rest) {
      if (extra.own) {
        if (!keptWarned.has(extra.pageId)) {
          keptWarned.add(extra.pageId);
          console.warn(
            `[sketchspace] "${extra.pageName}" and "${kept!.pageName}" both show ` +
              `${extra.file} and both carry your own drawing, so both are kept`,
          );
        }
        continue;
      }
      deletePage(extra.pageId);
      pagesChanged = true;
      console.log(
        `[sketchspace] removed duplicate tab "${extra.pageName}" - ` +
          `another tab already shows ${extra.file}`,
      );
    }
  }

  if (pagesChanged) {
    broadcastPages(boardId);
  }
};

/** Run jobs one per tick, so a long queue never blocks serving. */
const runSoon = (jobs: (() => void)[]): void => {
  const next = () => {
    const job = jobs.shift();
    if (!job) {
      return;
    }
    try {
      job();
    } catch (error) {
      console.error("[sketchspace] deferred layout work failed:", error);
    }
    setImmediate(next);
  };
  setImmediate(next);
};

/** Whether a page carries anything the user drew - which exists nowhere else. */
const hasOwnWork = (pageId: string): boolean =>
  getElements(pageId).some(
    (el) => !el.isDeleted && !(el.customData as { bonsai?: unknown } | undefined)?.bonsai,
  );

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

  const adopted: string[] = [];
  for (const layoutPath of wanted.keys()) {
    if (watchers.has(layoutPath) || !existsSync(layoutPath)) {
      continue;
    }
    adopted.push(layoutPath);
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

  // Newly adopted layouts - every one, at startup - need their templates
  // filled: boards imported before values existed, while the server was down,
  // or by a CLI that could only use what was already cached. Those with values
  // on hand are rendered now; the rest are notified once their IFC is read.
  // A drawing regenerated at a different size while we were not running leaves
  // the layout's box stale, and the drawing stretched into it. Cheap to check,
  // so it is checked on adoption rather than waiting for the next change.
  const resized = new Set(adopted.filter((layoutPath) => drawingSizesChanged(layoutPath)));
  const jobs: (() => void)[] = [];
  for (const layoutPath of resized) {
    jobs.push(() => resyncLayoutAssets(layoutPath, broadcast, "drawing resized"));
  }
  for (const layoutPath of primeLayoutValues(adopted)) {
    if (!resized.has(layoutPath)) {
      jobs.push(() => resyncLayoutAssets(layoutPath, broadcast, "template values applied", true));
    }
  }
  // One sheet per tick. At startup this is every sheet of every board, and a
  // full re-sync re-reads and re-hashes every drawing on a sheet - done in one
  // go it held the event loop long enough that the server never got to listen.
  runSoon(jobs);
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

  // Model values arrive in the background; fill templates in when they do.
  const stopValues = onLayoutValuesChanged((layoutPaths) => {
    for (const layoutPath of layoutPaths) {
      resyncLayoutAssets(layoutPath, broadcast, "template values changed", true);
    }
  });

  return () => {
    stopValues();
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
