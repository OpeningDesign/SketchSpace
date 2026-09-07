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
import { readFileSync } from "node:fs";
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
const mm = (v: unknown): number => num(String(v ?? "").replace(/mm$/i, ""));

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
    /(xlink:href|href)\s*=\s*"([^"]+)"/g,
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

export const parseLayout = (layoutPath: string): Layout => {
  const xml = readFileSync(layoutPath, "utf8");
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

  for (const g of asArray<Record<string, any>>(svg.g)) {
    const dataType = String(g["@_data-type"] ?? "");
    const kind: PlacementKind =
      dataType === "titleblock" || dataType === "drawing" || dataType === "reference"
        ? dataType
        : "other";

    const { tx, ty } = parseTranslate(g["@_transform"]);
    const locked = String(g["@_sodipodi:insensitive"] ?? "") === "true";
    const globalId =
      (g["@_data-drawing"] as string | undefined) ??
      (g["@_data-document"] as string | undefined) ??
      null;
    const stepId = (g["@_data-id"] as string | undefined) ?? null;
    // Inkscape and Bonsai both give every <g> an id; it is the stable handle
    // for rewriting one group's transform without touching the rest of the file.
    const groupKey = String(g["@_id"] ?? stepId ?? `g${placements.length}`);

    for (const img of asArray<Record<string, any>>(g.image)) {
      const rawHref = String(img["@_xlink:href"] ?? img["@_href"] ?? "");
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
