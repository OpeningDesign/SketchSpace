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
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";

import { db } from "./db.js";
import { syncPageWithLayout } from "./layoutSync.js";
import { applyUpdate, getElements } from "./store.js";

import type { SyncElement } from "./types.js";

/** Coalesce editor save flurries, and keep Dropbox churn down. */
const DEBOUNCE_MS = 1500;
/** How often to notice layouts belonging to newly imported boards. */
const RESCAN_MS = 30_000;

const watchers = new Map<string, FSWatcher>();
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

const refreshWatches = (broadcast: Broadcast): void => {
  const wanted = scanLayouts();

  for (const [layoutPath, watcher] of watchers) {
    if (!wanted.has(layoutPath)) {
      watcher.close();
      watchers.delete(layoutPath);
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

export const startLayoutWatcher = (broadcast: Broadcast): (() => void) => {
  refreshWatches(broadcast);
  const rescan = setInterval(() => refreshWatches(broadcast), RESCAN_MS);
  rescan.unref();

  return () => {
    clearInterval(rescan);
    for (const w of watchers.values()) {
      w.close();
    }
    watchers.clear();
  };
};
