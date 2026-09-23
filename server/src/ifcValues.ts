/**
 * The values Bonsai fills into view-titles and titleblocks, read from the IFC.
 *
 * Layouts hold templates - `{{Name}}`, `{{Scale}}`, a `{{#revisions}}` table -
 * and Bonsai fills them only when it builds a sheet. To show real values here,
 * the same data has to come from the model. `server/python/ifc_values.py` builds
 * it with IfcOpenShell, exactly as `sheeter.py` does; this module runs it,
 * caches the result, and decides which IFC a layout belongs to.
 *
 * Reading the saved file is the view-only half of the design. The model open in
 * Blender may hold unsaved changes, and edits must go through Bonsai rather than
 * the file - that is the live bridge (`bonsaiBridge.ts`), whose answers take the
 * same shape and win while Blender has the model open.
 *
 * Extraction is slow on a large model (seconds), so it never blocks: a layout
 * renders with raw placeholders until values arrive, then listeners re-sync it.
 * Results are cached on disk by IFC path, modified time and size, so a restart
 * costs nothing - and a CLI import can use values the server already read,
 * without starting an extraction it would not wait for.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
  type Stats,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { normalisePath } from "./paths.js";

import type { North, TemplateData } from "./templates.js";

type Text = Record<string, string>;

type SheetExtract = {
  identification: string;
  layout: string;
  /**
   * Text, except that Bonsai's live answer may also carry the titleblock's own
   * `revisions` rows and `has_revisions` flag - which are then used as given.
   */
  values: TemplateData;
  placements: Record<string, Text>;
  /**
   * The same view-title data for drawings, by GlobalId. Used when the file
   * lookup fails: a drawing renamed in Blender but not saved has already been
   * moved on disk and relinked in the layout, while the saved model still names
   * the old file.
   */
  drawings?: Record<string, Text>;
};

/** One model's values: from `ifc_values.py`, or live from Bonsai - same shape. */
export type IfcExtract = { ifc: string; sheets: SheetExtract[]; north: North };

/**
 * Bump when `ifc_values.py` output changes shape, so older cache entries are
 * read again rather than served until the model happens to change.
 */
const CACHE_FORMAT = 8;

type Cached = { format?: number; mtimeMs: number; size: number; extract: IfcExtract };

export type Revision = {
  rev: string;
  date: string;
  description: string;
  author: string;
  issued: string;
  y: number;
};

export type LayoutValues = {
  /** The IFC these came from. */
  ifc: string;
  /** Live from the model open in Blender, or read from the saved file. */
  source: "bonsai" | "saved file";
  /** Titleblock data: the sheet's attributes, its site and building, and the revisions table. */
  titleblock: TemplateData;
  north: North;
  /** View-title data for the placement showing this file, if the sheet has one. */
  placement: (contentPath: string) => Text | undefined;
  /** View-title data for a drawing, by GlobalId - the fallback when the file does not match. */
  drawing: (globalId: string) => Text | undefined;
};

type Listener = (layoutPaths: string[]) => void;

const SCRIPT = fileURLToPath(new URL("../../server/python/ifc_values.py", import.meta.url));
const CACHE_DIR = path.join(config.dataDir, "ifc-values");
/** An IFC save is one large write; wait for it to settle before reading. */
const SETTLE_MS = 2000;
/** Tags are made without touching the IFC, so they are looked for on a timer. */
const REVISION_POLL_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;

let enabled = false;
const memory = new Map<string, Cached>();
/**
 * Values sent live by a connected Blender, by connection. They win over the
 * saved file for the same IFC: they include edits not yet saved.
 */
const live = new Map<string, { extract: IfcExtract; receivedAt: number }>();
/** IFCs whose current version could not be read - not retried until they change. */
const failed = new Map<string, string>();
const queue: string[] = [];
const queued = new Set<string>();
let running = false;
/**
 * The file being read right now. Not queued again while it is: on Windows the
 * directory watcher reports file *access*, so the read itself fires an event
 * that would otherwise queue the same file a second time. A genuine save during
 * the read is caught when it finishes, by comparing the file before and after.
 */
let runningKey: string | null = null;
const listeners = new Set<Listener>();
/** Project directory -> the layouts in it that something has asked about. */
const layoutsByDir = new Map<string, Map<string, string>>();
const dirWatchers = new Map<string, FSWatcher>();
const settleTimers = new Map<string, NodeJS.Timeout>();
const revisions = new Map<string, { dir: string; signature: string; rows: Revision[] }>();
const warned = new Set<string>();

const signatureOf = (st: Stats) => `${st.mtimeMs}:${st.size}`;

/** Bonsai keeps layouts in a directory beside the IFC. */
const projectDirOf = (layoutPath: string) => path.dirname(path.dirname(layoutPath));

const cacheFileOf = (ifc: string) =>
  path.join(CACHE_DIR, `${createHash("sha1").update(normalisePath(ifc)).digest("hex")}.json`);

const candidateIfcs = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".ifc"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
};

const notify = (dir: string) => {
  const known = layoutsByDir.get(normalisePath(dir));
  // Layouts renamed or deleted since they were asked about are dropped here;
  // re-rendering them would only fail to open the file.
  for (const [key, layoutPath] of known ?? []) {
    if (!existsSync(layoutPath)) {
      known!.delete(key);
    }
  }
  const layouts = [...(known?.values() ?? [])];
  if (layouts.length === 0) {
    return;
  }
  for (const listener of listeners) {
    try {
      listener(layouts);
    } catch (error) {
      console.error("[sketchspace] template value listener failed:", error);
    }
  }
};

/* ------------------------------ extraction ------------------------------- */

const enqueue = (ifc: string) => {
  const key = normalisePath(ifc);
  if (!enabled || queued.has(key) || key === runningKey) {
    return;
  }
  queued.add(key);
  queue.push(ifc);
  pump();
};

const pump = () => {
  if (running || queue.length === 0) {
    return;
  }
  const ifc = queue.shift()!;
  const key = normalisePath(ifc);
  queued.delete(key);

  let before: Stats;
  try {
    before = statSync(ifc);
  } catch {
    pump();
    return;
  }

  running = true;
  runningKey = key;
  const started = Date.now();
  execFile(
    config.python,
    [SCRIPT, ifc],
    { maxBuffer: 256 * 1024 * 1024, timeout: EXTRACT_TIMEOUT_MS, windowsHide: true },
    (error, stdout, stderr) => {
      running = false;
      runningKey = null;
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          parsed = undefined;
        }
        const reported =
          parsed && typeof parsed === "object" && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : undefined;
        if (!parsed || typeof parsed !== "object" || reported || !("sheets" in parsed)) {
          throw new Error(
            reported || stderr.trim().split("\n").pop() || error?.message || "no output",
          );
        }

        // Saved again while we were reading it: what we have is already stale.
        const after = statSync(ifc);
        if (signatureOf(after) !== signatureOf(before)) {
          enqueue(ifc);
          return;
        }

        const extract = parsed as IfcExtract;
        const previous = memory.get(key);
        const cached: Cached = {
          format: CACHE_FORMAT,
          mtimeMs: before.mtimeMs,
          size: before.size,
          extract,
        };
        memory.set(key, cached);
        failed.delete(key);
        try {
          mkdirSync(CACHE_DIR, { recursive: true });
          writeFileSync(cacheFileOf(ifc), JSON.stringify(cached));
        } catch (cacheError) {
          console.warn(`[sketchspace] could not cache template values for ${ifc}:`, cacheError);
        }

        console.log(
          `[sketchspace] read template values from ${path.basename(ifc)}: ` +
            `${extract.sheets.length} sheet(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
        );
        if (JSON.stringify(previous?.extract) !== JSON.stringify(extract)) {
          notify(path.dirname(ifc));
        }
      } catch (failure) {
        failed.set(key, signatureOf(before));
        const message = failure instanceof Error ? failure.message : String(failure);
        const hint = /ENOENT|No module named/.test(message)
          ? ` - is SKETCHSPACE_PYTHON (${config.python}) a Python with ifcopenshell installed?`
          : "";
        console.warn(`[sketchspace] could not read template values from ${ifc}: ${message}${hint}`);
      } finally {
        pump();
      }
    },
  );
};

/**
 * The cached extract for this version of the file, or - while a newer version
 * is being read - the previous one. Stale values beat raw placeholders.
 */
const lookup = (ifc: string, st: Stats): Cached | undefined => {
  const key = normalisePath(ifc);
  const current = (c: Cached | undefined) =>
    c && c.format === CACHE_FORMAT && c.mtimeMs === st.mtimeMs && c.size === st.size
      ? c
      : undefined;

  let known = memory.get(key);
  if (current(known)) {
    return known;
  }

  if (!known) {
    const file = cacheFileOf(ifc);
    if (existsSync(file)) {
      try {
        known = JSON.parse(readFileSync(file, "utf8")) as Cached;
        // Current or not, it is the best there is until the file is read again.
        memory.set(key, known);
        if (current(known)) {
          return known;
        }
      } catch {
        // A corrupt cache entry is just a miss.
      }
    }
  }

  if (failed.get(key) !== signatureOf(st)) {
    enqueue(ifc);
  }
  return known;
};

/* ------------------------------- revisions ------------------------------- */

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase())
    .join("");

const localDate = (unixSeconds: number) => {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * The titleblock's revision table: one row per git tag on the IFC's repository.
 *
 * Mirrors `SheetBuilder._get_git_revisions` (Bonsai, f105c6f1fa) field for
 * field - oldest tag first, dated by the tagged commit, the first line of an
 * annotated tag's message, the tagger's initials (the commit author's, for a
 * lightweight tag), and `y` stepping up 5 mm a row. Read with git itself, so the
 * server needs no GitPython, and the table appears whichever Bonsai build the
 * sheet was made with.
 */
const readRevisions = (dir: string): Revision[] => {
  const git = (args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });

  let raw: string;
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
    raw = git([
      "for-each-ref",
      "refs/tags",
      "--format=" +
        [
          "%(refname:short)",
          "%(objecttype)",
          "%(*committerdate:unix)",
          "%(committerdate:unix)",
          "%(taggername)",
          "%(authorname)",
          "%(contents)",
        ].join("%1f") +
        "%1e",
    ]);
  } catch {
    return []; // not a repository, or no git
  }

  const tags = raw
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [name, type, derefDate, date, tagger, author, contents] = record.split("\x1f");
      const annotated = type === "tag";
      return {
        name: name ?? "",
        committed: Number(annotated ? derefDate : date) || 0,
        description: annotated ? ((contents ?? "").trim().split(/\r?\n/)[0] ?? "") : "",
        author: initials((annotated ? tagger : author) ?? ""),
      };
    });

  // Stable sort: tags on the same commit keep git's (name) order.
  tags.sort((a, b) => a.committed - b.committed);

  return tags.map((tag, i) => ({
    rev: tag.name,
    date: localDate(tag.committed),
    description: tag.description,
    author: tag.author,
    issued: "",
    y: i === 0 ? 0 : -i * 5,
  }));
};

const revisionsFor = (dir: string): Revision[] => {
  const key = normalisePath(dir);
  const known = revisions.get(key);
  if (known) {
    return known.rows;
  }
  const rows = readRevisions(dir);
  revisions.set(key, { dir, signature: JSON.stringify(rows), rows });
  return rows;
};

const pollRevisions = () => {
  for (const [key, known] of revisions) {
    const rows = readRevisions(known.dir);
    const signature = JSON.stringify(rows);
    if (signature !== known.signature) {
      revisions.set(key, { dir: known.dir, signature, rows });
      notify(known.dir);
    }
  }
};

/* -------------------------------- watching ------------------------------- */

const watchProjectDir = (dir: string) => {
  const key = normalisePath(dir);
  if (!enabled || dirWatchers.has(key)) {
    return;
  }
  try {
    const watcher = watch(dir, (_event, filename) => {
      if (!filename || !filename.toString().toLowerCase().endsWith(".ifc")) {
        return;
      }
      const ifc = path.join(dir, filename.toString());
      clearTimeout(settleTimers.get(ifc));
      settleTimers.set(
        ifc,
        setTimeout(() => {
          settleTimers.delete(ifc);
          if (existsSync(ifc)) {
            lookup(ifc, statSync(ifc));
          } else {
            // Deleted or renamed away: whatever it provided is gone with it.
            memory.delete(normalisePath(ifc));
            notify(dir);
          }
        }, SETTLE_MS),
      );
    });
    watcher.on("error", () => {
      watcher.close();
      dirWatchers.delete(key);
    });
    dirWatchers.set(key, watcher);
  } catch (error) {
    console.warn(`[sketchspace] cannot watch ${dir} for IFC changes:`, error);
  }
};

/* ---------------------------------- API ---------------------------------- */

const toLayoutValues = (
  extract: IfcExtract,
  sheet: SheetExtract,
  source: LayoutValues["source"],
  dir: string,
): LayoutValues => {
  const placements = new Map(
    Object.entries(sheet.placements).map(([file, values]) => [normalisePath(file), values]),
  );
  // Bonsai builds with its own revision table where it has one; keep that
  // rather than a second reading of the same tags.
  const hasOwnRevisions = Array.isArray(sheet.values.revisions);
  const rows = hasOwnRevisions ? [] : revisionsFor(dir);

  return {
    ifc: extract.ifc,
    source,
    titleblock: hasOwnRevisions
      ? sheet.values
      : { ...sheet.values, revisions: rows, has_revisions: rows.length > 0 },
    north: extract.north,
    placement: (contentPath) => placements.get(normalisePath(contentPath)),
    drawing: (globalId) => sheet.drawings?.[globalId],
  };
};

/**
 * The live values for a layout, if a connected Blender has its model open.
 * The most recent answer wins when more than one does.
 */
const liveValuesFor = (dirKey: string, target: string) => {
  let best:
    | { source: string; extract: IfcExtract; sheet: SheetExtract; receivedAt: number }
    | undefined;
  for (const [source, { extract, receivedAt }] of live) {
    if (normalisePath(path.dirname(extract.ifc)) !== dirKey) {
      continue;
    }
    const sheet = extract.sheets.find((s) => normalisePath(s.layout) === target);
    if (sheet && (!best || receivedAt > best.receivedAt)) {
      best = { source, extract, sheet, receivedAt };
    }
  }
  return best;
};

/**
 * Which connected Blender has this layout's model open, or null.
 *
 * An edit is sent to that Blender and nowhere else: the model it holds in memory
 * is the one the values came from, and writing to the saved file instead would
 * be invisible to it and lost on its next save (NOTES.md).
 */
export const liveSourceForLayout = (layoutPath: string): string | null =>
  liveValuesFor(normalisePath(projectDirOf(layoutPath)), normalisePath(layoutPath))?.source ?? null;

/**
 * Template values for a layout, or null if none are available yet.
 *
 * A Blender that has the layout's model open answers first - its values include
 * unsaved edits. Otherwise they come from the saved file.
 *
 * The layout's IFC is the one whose sheet actually references it, not merely
 * one in the same folder - project folders hold merged copies and exports.
 * When several do, the most recently saved wins, and that is logged once.
 */
export const getLayoutValues = (layoutPath: string): LayoutValues | null => {
  const dir = projectDirOf(layoutPath);
  const dirKey = normalisePath(dir);
  const target = normalisePath(layoutPath);

  let known = layoutsByDir.get(dirKey);
  if (!known) {
    known = new Map();
    layoutsByDir.set(dirKey, known);
  }
  if (!known.has(target)) {
    known.set(target, layoutPath);
  }
  watchProjectDir(dir);

  const fromBonsai = liveValuesFor(dirKey, target);
  if (fromBonsai) {
    return toLayoutValues(fromBonsai.extract, fromBonsai.sheet, "bonsai", dir);
  }

  const matches: { cached: Cached; sheet: SheetExtract; mtimeMs: number }[] = [];
  for (const ifc of candidateIfcs(dir)) {
    let st: Stats;
    try {
      st = statSync(ifc);
    } catch {
      continue;
    }
    const cached = lookup(ifc, st);
    const sheet = cached?.extract.sheets.find((s) => normalisePath(s.layout) === target);
    if (cached && sheet) {
      matches.push({ cached, sheet, mtimeMs: st.mtimeMs });
    }
  }
  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const { cached, sheet } = matches[0]!;
  if (matches.length > 1 && !warned.has(target)) {
    warned.add(target);
    console.warn(
      `[sketchspace] ${path.basename(layoutPath)} is referenced by ${matches.length} IFC files; ` +
        `using the most recently saved, ${path.basename(cached.extract.ifc)}`,
    );
  }

  return toLayoutValues(cached.extract, sheet, "saved file", dir);
};

/**
 * Record what a connected Blender reports - or, with null, that it has gone.
 * Layouts in the affected project are re-rendered if anything changed, so a
 * disconnect falls back to the saved file's values by itself.
 */
export const setLiveValues = (source: string, extract: IfcExtract | null): void => {
  const previous = live.get(source)?.extract;
  if (extract && extract.ifc) {
    live.set(source, { extract, receivedAt: Date.now() });
  } else {
    live.delete(source);
  }
  const current = live.get(source)?.extract;
  if (JSON.stringify(previous) === JSON.stringify(current)) {
    return;
  }
  const dirs = new Set(
    [previous?.ifc, current?.ifc].filter((ifc): ifc is string => Boolean(ifc)).map((ifc) =>
      path.dirname(ifc),
    ),
  );
  for (const dir of dirs) {
    notify(dir);
  }
};

/**
 * Ask for values up front. Returns the layouts whose values are available right
 * now, which the caller should render; the rest are notified when they arrive.
 */
export const primeLayoutValues = (layoutPaths: Iterable<string>): string[] =>
  [...layoutPaths].filter((layoutPath) => getLayoutValues(layoutPath) !== null);

/** Called with the layouts whose values changed; the watcher re-syncs them. */
export const onLayoutValuesChanged = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Let this process read IFCs and watch for changes. Only the server does; a CLI
 * uses whatever the server has cached, rather than starting a slow extraction
 * it would then either wait for or abandon.
 */
export const enableIfcExtraction = (): (() => void) => {
  enabled = true;
  const poll = setInterval(pollRevisions, REVISION_POLL_MS);
  poll.unref();
  return () => {
    enabled = false;
    clearInterval(poll);
    for (const watcher of dirWatchers.values()) {
      watcher.close();
    }
    dirWatchers.clear();
    for (const timer of settleTimers.values()) {
      clearTimeout(timer);
    }
    settleTimers.clear();
  };
};
