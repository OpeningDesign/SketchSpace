/**
 * Remember which asset a drawing produced, so an unchanged drawing is not reread.
 *
 * Turning a drawing into an asset means reading the whole SVG, reading every image
 * it links to, base64-ing those into it, hashing the result and writing it out.
 * For one sheet here that is 21.2 MB across 14 files, and a cold start did it for
 * every sheet of every project: `sync A750 - ADA RESTROOM PLAN AND ELEVATIONS.svg
 * took 17.6s`, against 0.0s for the same job once the filesystem was warm. None of
 * it produces anything new when none of the files have changed - the asset is named
 * after its own hash, so the same input writes the same file back over itself.
 *
 * So the answer is cached against every file that went into it: the drawing, and
 * each image inlined into it. The nested list comes from reading the drawing, so
 * the first pass still pays in full and records what it depended on; later passes
 * stat that list, which is ~0.5ms a file against ~135ms to open one cold on a
 * Dropbox path. A redrawn underlay changes its own mtime and is therefore still
 * noticed, which keying on the drawing alone would have missed.
 *
 * Not used for view-titles. Those are templates filled with values from the model,
 * so their output depends on more than the files, and they are a few KB each.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { config } from "./config.js";

/** A file the asset was built from, and how it looked at the time. */
type Dependency = { path: string; mtimeMs: number; size: number };
type Entry = { deps: Dependency[]; fileId: string };

const CACHE_FILE = path.join(config.dataDir, "linked-assets.json");

const cache = new Map<string, Entry>();
let loaded = false;
let dirty = false;
let saveTimer: NodeJS.Timeout | undefined;

const keyOf = (file: string): string => {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const load = (): void => {
  loaded = true;
  try {
    const stored = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Record<string, Entry>;
    for (const [key, entry] of Object.entries(stored)) {
      // A malformed entry would hand back a fileId for an asset built from
      // something else, so anything not shaped right is dropped rather than
      // trusted.
      if (
        typeof entry?.fileId === "string" &&
        entry.fileId.length > 0 &&
        Array.isArray(entry.deps) &&
        entry.deps.every(
          (d) =>
            typeof d?.path === "string" &&
            typeof d.mtimeMs === "number" &&
            typeof d.size === "number",
        )
      ) {
        cache.set(key, entry);
      }
    }
  } catch {
    // No cache yet, or an unreadable one. It rebuilds itself.
  }
};

/** One write for a burst of misses, not one per miss. */
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
      console.warn(`[sketchspace] could not save the linked asset cache:`, error);
    }
  }, 2000);
  saveTimer.unref();
};

const cost = { hits: 0, misses: 0, bytesSaved: 0 };

export const takeLinkedAssetCost = (): typeof cost => {
  const taken = { ...cost };
  cost.hits = 0;
  cost.misses = 0;
  cost.bytesSaved = 0;
  return taken;
};

const unchanged = (deps: Dependency[]): boolean => {
  for (const dep of deps) {
    let stats;
    try {
      stats = statSync(dep.path);
    } catch {
      return false; // Gone; whatever was built from it has to be rebuilt.
    }
    if (stats.mtimeMs !== dep.mtimeMs || stats.size !== dep.size) {
      return false;
    }
  }
  return true;
};

/**
 * The asset this drawing last produced, if nothing it was built from has changed.
 *
 * @returns the fileId, or null when it has to be built again.
 */
export const cachedAssetFor = (href: string): string | null => {
  if (!loaded) {
    load();
  }
  const entry = cache.get(keyOf(href));
  if (!entry || !unchanged(entry.deps)) {
    cost.misses++;
    return null;
  }
  cost.hits++;
  cost.bytesSaved += entry.deps.reduce((sum, d) => sum + d.size, 0);
  return entry.fileId;
};

/**
 * Record what an asset was built from.
 *
 * `sources` are the files inlined into it, which `inlineNestedImages` reports.
 * The drawing itself is added here, since it is a dependency like any other.
 */
export const rememberAsset = (href: string, sources: string[], fileId: string): void => {
  if (!loaded) {
    load();
  }
  const deps: Dependency[] = [];
  for (const file of [href, ...sources]) {
    try {
      const stats = statSync(file);
      deps.push({ path: file, mtimeMs: stats.mtimeMs, size: stats.size });
    } catch {
      // Something we just read has gone. Recording a dependency we cannot stat
      // would make the entry permanently stale, so drop the entry entirely.
      return;
    }
  }
  cache.set(keyOf(href), { deps, fileId });
  scheduleSave();
};
