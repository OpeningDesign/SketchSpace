/**
 * Remember how big each drawing is, so a sheet can be checked without opening it.
 *
 * `intrinsicSizeMm` reads the first 8KB of a drawing to find the size its root
 * `<svg>` declares. That is cheap work on a normal disk and expensive here: every
 * project file is a Dropbox placeholder, and a cold `open` costs ~135ms against
 * ~0.8ms on plain NTFS. A startup makes 526 of those reads - 245 checking
 * adopted layouts, 281 in the resync jobs - which measured 28.0s of a 43.1s
 * startup, against 0.1s once the filesystem had gone warm.
 *
 * `stat` is barely affected: 0.5-0.7ms cold against 17-18ms for an open and read
 * of the same directory. So the answer is cached against the file's mtime and
 * size, and a cold start pays one cheap stat per drawing instead of one
 * expensive open.
 *
 * The cache is kept on disk beside the IFC value cache, so a restart starts warm
 * rather than rebuilding what has not changed.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { intrinsicSizeMm } from "./bonsaiLayout.js";
import { config } from "./config.js";

type Entry = {
  mtimeMs: number;
  size: number;
  /** Zero when the file is not an SVG we can measure - cached so it is not reread. */
  width: number;
  height: number;
};

const CACHE_FILE = path.join(config.dataDir, "drawing-sizes.json");

const cache = new Map<string, Entry>();
let loaded = false;
let dirty = false;
let saveTimer: NodeJS.Timeout | undefined;

/** Windows paths differ only in case, and the same drawing arrives spelled both ways. */
const keyOf = (file: string): string => {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const load = (): void => {
  loaded = true;
  try {
    const stored = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Record<string, Entry>;
    for (const [key, entry] of Object.entries(stored)) {
      // Anything shaped wrong is dropped rather than trusted; a bad entry would
      // hand out a wrong drawing size, which shows up as a stretched drawing.
      if (
        typeof entry?.mtimeMs === "number" &&
        typeof entry.size === "number" &&
        typeof entry.width === "number" &&
        typeof entry.height === "number"
      ) {
        cache.set(key, entry);
      }
    }
  } catch {
    // No cache yet, or an unreadable one. Either way it rebuilds itself.
  }
};

/**
 * Written on a timer rather than per miss: a cold start misses hundreds of times
 * in a few seconds, and that should be one write.
 */
const scheduleSave = (): void => {
  dirty = true;
  if (saveTimer) {
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    if (!dirty) {
      return;
    }
    dirty = false;
    try {
      mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)));
    } catch (error) {
      console.warn(`[sketchspace] could not save the drawing size cache:`, error);
    }
  }, 2000);
  saveTimer.unref();
};

/** Hits and misses since the last report, for the startup timings to quote. */
const cost = { hits: 0, misses: 0, missing: 0 };

export const takeDrawingSizeCost = (): typeof cost => {
  const taken = { ...cost };
  cost.hits = 0;
  cost.misses = 0;
  cost.missing = 0;
  return taken;
};

/**
 * The size this drawing declares, from cache when the file has not changed.
 *
 * @returns null for anything that cannot be measured - a missing file, or one
 *   whose root element carries no usable width and height.
 */
export const drawingSizeMm = (
  file: string,
): { width: number; height: number } | null => {
  if (!loaded) {
    load();
  }

  let stats;
  try {
    stats = statSync(file);
  } catch {
    // Gone, or never there. Nothing to cache against.
    cost.missing++;
    return null;
  }

  const key = keyOf(file);
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === stats.mtimeMs && hit.size === stats.size) {
    cost.hits++;
    return hit.width > 0 && hit.height > 0 ? { width: hit.width, height: hit.height } : null;
  }

  cost.misses++;
  const measured = intrinsicSizeMm(file);
  cache.set(key, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    // A file we could not measure is remembered as unmeasurable, so it is not
    // reopened on every pass. It is still keyed on mtime, so regenerating it
    // gets it measured again.
    width: measured?.width ?? 0,
    height: measured?.height ?? 0,
  });
  scheduleSave();
  return measured;
};
