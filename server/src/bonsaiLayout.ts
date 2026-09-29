/**
 * Reads a Bonsai *layout* SVG.
 *
 * Bonsai keeps two artefacts per sheet:
 *
 *   layouts/A001 - SITE PLAN.svg    ~3 KB   structure + links   <- source
 *   sheets/A001 - SITE PLAN.svg     ~6 MB   rasterised composite <- build output
 *
 * We read the layout, never the sheet. The layout says which drawings sit where
 * and links to them, so a drawing can be regenerated from the model a hundred
 * times without disturbing the arrangement. It is also a 3 KB diff in git rather
 * than a 6 MB blob, and the built sheet is base64 PNG all the way down - useless
 * to anchor a redline to.
 *
 * Layout structure:
 *
 *   <g data-type="titleblock" sodipodi:insensitive="true">
 *     <image xlink:href="titleblocks/22x34.svg" x y width height/>
 *   </g>
 *   <g data-type="drawing" data-id="3949523" data-drawing="0JUeuOOBbA69UNLLp9hYYj"
 *      transform="translate(53.677831,2.0645319)">
 *     <image data-type="foreground" xlink:href="..\drawings\SITE PLAN.svg" x y w h/>
 *     <image data-type="view-title" xlink:href="assets\view-title.svg" .../>
 *   </g>
 *
 * `data-drawing` is an IFC GlobalId - the stable anchor a redline should hang
 * off, since it survives regeneration, renaming and re-arrangement.
 */
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

export type PlacementKind = "titleblock" | "drawing" | "reference" | "other";

export type Placement = {
  kind: PlacementKind;
  /** IFC GlobalId from data-drawing / data-document, when present. */
  globalId: string | null;
  /** IFC step id from data-id. File-local, less stable than globalId. */
  stepId: string | null;
  /** data-type on the <image>: foreground, view-title, content, ... */
  role: string;
  /** Absolute path to the linked SVG on disk. */
  href: string;
  /** Position in millimetres, with the group transform already composed in. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Bonsai marks the titleblock sodipodi:insensitive - i.e. locked. */
  locked: boolean;
  /**
   * The `id` attribute of the owning <g>. Identifies which group to rewrite on
   * write-back, and binds sibling images (foreground + view-title) so they move
   * together rather than drifting apart.
   */
  groupKey: string;
  /** The image's own x/y, before the group transform. Bonsai owns these. */
  imgX: number;
  imgY: number;
  /** The group's translate at import time. This is what write-back rewrites. */
  groupTx: number;
  groupTy: number;
};

export type Layout = {
  path: string;
  name: string;
  widthMm: number;
  heightMm: number;
  placements: Placement[];
  /** Links that could not be resolved on disk. */
  missing: string[];
};

/** CSS reference pixels per millimetre (96 dpi). */
export const MM_TO_PX = 96 / 25.4;

const num = (v: unknown, fallback = 0): number => {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
};

/** "863.59998mm" -> 863.59998 */
/**
 * A length in millimetres, in the units SVG allows - mirroring
 * `SheetBuilder.convert_to_mm`. A bare number is user units, which in Bonsai's
 * layouts and drawings are millimetres.
 */
const UNITS_TO_MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  q: 0.25,
  in: 25.4,
  pc: 25.4 / 6,
  pt: 25.4 / 72,
  px: 25.4 / 96,
};

const mm = (v: unknown): number => {
  const text = String(v ?? "").trim();
  const match = /^([-\d.eE+]+)\s*(mm|cm|Q|in|pc|pt|px)?$/.exec(text);
  if (!match) {
    return num(text.replace(/mm$/i, ""));
  }
  return num(match[1]) * (match[2] ? (UNITS_TO_MM[match[2].toLowerCase()] ?? 1) : 1);
};

/**
 * What the head reads have cost since the last report.
 *
 * Reading 8KB of each drawing is cheap work and was still 28s of a 43s startup,
 * because the cost is per *open* on a Dropbox path that has gone cold, not per
 * byte: the same 245 reads take 0.1s once warm. Counting reads and their total
 * time separates "too much work" from "a slow filesystem", which is the
 * difference between caching the answers and doing less of it.
 */
const headReadCost = { reads: 0, ms: 0, slowestMs: 0, slowest: "" };

export const takeHeadReadCost = (): typeof headReadCost => {
  const taken = { ...headReadCost };
  headReadCost.reads = 0;
  headReadCost.ms = 0;
  headReadCost.slowestMs = 0;
  headReadCost.slowest = "";
  return taken;
};

/**
 * The size an SVG declares on its own root element, in millimetres.
 *
 * A drawing regenerated at a different size does not resize its placement: the
 * layout keeps the old width and height until Bonsai reflows the sheet
 * (`update_sheet_drawing_sizes`, run by Open Layout and Create Sheets). Until
 * then the layout's box and the drawing disagree, and drawing one into the
 * other stretches it - so the file's own size is what gets used.
 *
 * Only the head of the file is read: these attributes are on the root element,
 * and a drawing can be megabytes.
 */
/**
 * Callers go through `drawingSizes.drawingSizeMm`, which caches this against the
 * file's mtime: on a Dropbox path the open, not the parsing, is what costs.
 */
export const intrinsicSizeMm = (
  file: string,
): { width: number; height: number } | null => {
  let head: string;
  const readStarted = Date.now();
  headReadCost.reads++;
  try {
    const handle = openSync(file, "r");
    const buffer = Buffer.alloc(8192);
    const read = readSync(handle, buffer, 0, buffer.length, 0);
    closeSync(handle);
    head = buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    const took = Date.now() - readStarted;
    headReadCost.ms += took;
    if (took > headReadCost.slowestMs) {
      headReadCost.slowestMs = took;
      headReadCost.slowest = file;
    }
  }

  const root = /<svg\b[^>]*>/.exec(head);
  if (!root) {
    return null; // not an SVG, or a root tag longer than the head we read
  }
  const attr = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(root[0])?.[1];
  const width = mm(attr("width"));
  const height = mm(attr("height"));
  return width > 0 && height > 0 ? { width, height } : null;
};

/**
 * Bonsai writes x/y onto the <image>; Inkscape adds transform="translate(..)"
 * to the <g> when you drag it. Both are present in the wild, so both count.
 */
const parseTranslate = (transform: unknown): { tx: number; ty: number } => {
  const m = /translate\(\s*([-\d.eE]+)[ ,]+([-\d.eE]+)\s*\)/.exec(
    String(transform ?? ""),
  );
  return m ? { tx: num(m[1]), ty: num(m[2]) } : { tx: 0, ty: 0 };
};

/**
 * Layout hrefs are URL-encoded and, on Windows, use backslashes:
 *   "..%5Cdrawings%5CSITE%20PLAN%20-%20OVERALL.svg"
 * That is not portable, so normalise rather than trusting it.
 */
export const resolveHref = (href: string, layoutDir: string): string => {
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    // Malformed escapes - fall back to the raw string.
  }
  return path.resolve(layoutDir, decoded.replace(/\\/g, "/"));
};

const asArray = <T,>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/**
 * Read an attribute by local name, ignoring its namespace prefix.
 *
 * Inkscape rewrites namespace prefixes when it saves, and not consistently: one
 * sheet has `xmlns:xlink` and `xlink:href`, another binds the same namespace as
 * `ns3` and writes `ns3:href`. Matching the prefix literally makes a whole sheet
 * parse to zero placements with no error at all.
 */
const attr = (node: Record<string, any>, localName: string): string | undefined => {
  const direct = node[`@_${localName}`];
  if (direct !== undefined) {
    return String(direct);
  }
  const suffix = `:${localName}`;
  for (const key of Object.keys(node)) {
    if (key.startsWith("@_") && key.slice(2).endsWith(suffix)) {
      return String(node[key]);
    }
  }
  return undefined;
};

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/**
 * Inline a drawing's own external image references.
 *
 * A drawing SVG can reference a raster underlay relatively:
 *
 *   <image xlink:href="SITE PLAN - OVERALL-underlay.png" .../>
 *
 * Once the SVG is itself base64'd into a data: URL there is no base to resolve
 * that against, so the underlay silently vanishes - the drawing renders as bare
 * linework over nothing. Bonsai's own sioserver.py does the same inlining for
 * the same reason.
 *
 * Returns the SVG with resolvable references replaced by data: URLs, plus any
 * that could not be found.
 */
export const inlineNestedImages = (
  svg: string,
  svgDir: string,
): { svg: string; inlined: number; missing: string[] } => {
  const missing: string[] = [];
  let inlined = 0;

  const out = svg.replace(
    /((?:[A-Za-z_][\w.-]*:)?href)\s*=\s*"([^"]+)"/g,
    (match, attr: string, href: string) => {
      if (/^(data:|https?:|#)/i.test(href)) {
        return match;
      }
      const target = resolveHref(href, svgDir);
      const mime = MIME_BY_EXT[path.extname(target).toLowerCase()];
      if (!mime) {
        return match;
      }
      try {
        const bytes = readFileSync(target);
        inlined++;
        return `${attr}="data:${mime};base64,${bytes.toString("base64")}"`;
      } catch {
        missing.push(href);
        return match;
      }
    },
  );

  return { svg: out, inlined, missing };
};

/**
 * A layout's text, retried while it looks half-written.
 *
 * Bonsai writes a layout with ElementTree's `tree.write`, which truncates the
 * file and then fills it, so a watcher that reads on the first change event can
 * catch it empty or cut short. Seen in the log as `has no <svg> root` during a
 * run of removals - harmless there, but a parse that fails is a layout that
 * looks like it places nothing, which is the same shape as every group having
 * been deleted.
 *
 * Blocking waits, because every caller is synchronous, and only on the failing
 * path: a whole file ends with `</svg>`, and that is cheap to check.
 */
const readWholeLayout = (layoutPath: string, attempts = 4, waitMs = 40): string => {
  let xml = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    xml = readFileSync(layoutPath, "utf8");
    if (xml.trimEnd().endsWith("</svg>")) {
      return xml;
    }
    if (attempt < attempts - 1) {
      // Sleep without an event loop turn; the callers cannot await.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  return xml;
};

export const parseLayout = (layoutPath: string): Layout => {
  const xml = readWholeLayout(layoutPath);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseAttributeValue: false,
    preserveOrder: false,
  });
  const doc = parser.parse(xml) as Record<string, any>;
  const svg = doc.svg;
  if (!svg) {
    throw new Error(`${layoutPath} has no <svg> root`);
  }

  const layoutDir = path.dirname(layoutPath);
  const placements: Placement[] = [];
  const missing: string[] = [];
  /** How many groups have claimed each key, so a repeat can be told apart. */
  const keysSeen = new Map<string, number>();

  for (const g of asArray<Record<string, any>>(svg.g)) {
    const dataType = String(g["@_data-type"] ?? "");
    const kind: PlacementKind =
      dataType === "titleblock" || dataType === "drawing" || dataType === "reference"
        ? dataType
        : "other";

    const { tx, ty } = parseTranslate(attr(g, "transform"));
    const locked = attr(g, "insensitive") === "true";
    const globalId =
      (g["@_data-drawing"] as string | undefined) ??
      (g["@_data-document"] as string | undefined) ??
      null;
    const stepId = (g["@_data-id"] as string | undefined) ?? null;
    // The handle for rewriting one group without touching the rest of the file.
    // Inkscape writes an `id`; Bonsai writes none, so this is usually the
    // `data-id` - the reference's STEP id.
    //
    // Which is not unique. IfcOpenShell reuses the id of a deleted entity, so a
    // group left behind by a removal that could not find it can carry the id a
    // later drawing is given. Two groups then share a key, and everything keyed
    // by it collapses: both view-titles take the first one's values (a title
    // reading "DETAIL 2" over a section), their elements share a group and move
    // together, and the writer rewrites whichever comes first. Seen in the
    // field. So a repeat is numbered, in document order.
    let groupKey = String(g["@_id"] ?? stepId ?? `g${placements.length}`);
    const seen = (keysSeen.get(groupKey) ?? 0) + 1;
    keysSeen.set(groupKey, seen);
    if (seen > 1) {
      groupKey = `${groupKey}#${seen}`;
    }

    for (const img of asArray<Record<string, any>>(g.image)) {
      const rawHref = attr(img, "href") ?? "";
      if (!rawHref) {
        continue;
      }
      const href = resolveHref(rawHref, layoutDir);
      placements.push({
        kind,
        globalId,
        stepId,
        role: String(img["@_data-type"] ?? "content"),
        href,
        x: num(img["@_x"]) + tx,
        y: num(img["@_y"]) + ty,
        width: num(img["@_width"]),
        height: num(img["@_height"]),
        locked,
        groupKey,
        imgX: num(img["@_x"]),
        imgY: num(img["@_y"]),
        groupTx: tx,
        groupTy: ty,
      });
    }
  }

  return {
    path: layoutPath,
    name: path.basename(layoutPath, path.extname(layoutPath)),
    widthMm: mm(svg["@_width"]),
    heightMm: mm(svg["@_height"]),
    placements,
    missing,
  };
};
