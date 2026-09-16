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
 * the file - that is the live bridge, still to come (NOTES.md). Whatever feeds
 * values in later should keep the shape `LayoutValues` has here.
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
  values: Text;
  placements: Record<string, Text>;
};

type IfcExtract = { ifc: string; sheets: SheetExtract[]; north: North };

type Cached = { mtimeMs: number; size: number; extract: IfcExtract };

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
  /** Titleblock data: the sheet's attributes, plus the revisions table. */
  titleblock: TemplateData;
  north: North;
  /** View-title data for the placement showing this file, if the sheet has one. */
  placement: (contentPath: string) => Text | undefined;
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
  const layouts = [...(layoutsByDir.get(normalisePath(dir))?.values() ?? [])];
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
        const cached: Cached = { mtimeMs: before.mtimeMs, size: before.size, extract };
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
    c && c.mtimeMs === st.mtimeMs && c.size === st.size ? c : undefined;

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

/**
 * Template values for a layout, or null if none are available yet.
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

  const placements = new Map(
    Object.entries(sheet.placements).map(([file, values]) => [normalisePath(file), values]),
  );
  const rows = revisionsFor(dir);

  return {
    ifc: cached.extract.ifc,
    titleblock: { ...sheet.values, revisions: rows, has_revisions: rows.length > 0 },
    north: cached.extract.north,
    placement: (contentPath) => placements.get(normalisePath(contentPath)),
  };
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
