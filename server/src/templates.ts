/**
 * Render Bonsai's sheet templates - view-titles and titleblocks - as Bonsai does.
 *
 * Bonsai fills them with pystache in `SheetBuilder.parse_embedded_svg`; this
 * uses mustache.js, which implements the same spec. The difference that would
 * show on a drawing is escaping: mustache.js also escapes `/`, `=` and
 * backticks, so a scale such as 1/4"=1'-0" would come out as different text
 * from Bonsai's built sheet. Python's `html.escape(quote=True)`, which pystache
 * uses, is reproduced instead.
 *
 * Values arrive already converted to text the way pystache converts them - an
 * unset attribute is the word "None", exactly as it prints on the built sheet.
 * Only `revisions` (a list) and `has_revisions` (a boolean) keep their types,
 * because the titleblock iterates and tests them.
 */
import Mustache from "mustache";

import { setAttr } from "./svgText.js";

export type TemplateData = Record<string, unknown>;

export type North = { grid: string; true: string };

const PYTHON_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

const escapeLikePython = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => PYTHON_ESCAPES[c]!);

/** Fill a template. A file with no tags is returned untouched. */
export const renderTemplate = (svg: string, data: TemplateData): string =>
  svg.includes("{{")
    ? Mustache.render(svg, data, {}, { escape: escapeLikePython })
    : svg;

/**
 * Point a titleblock's north arrows, as `SheetBuilder.build_titleblock` does:
 * any `<g data-type="grid-north">` or `"true-north"` gets its transform
 * replaced with the model's rotation.
 */
export const applyNorth = (svg: string, north: North): string =>
  svg.replace(
    /<g\b[^>]*\bdata-type\s*=\s*"(grid-north|true-north)"[^>]*>/g,
    (tag, kind: string) =>
      setAttr(tag, "transform", kind === "grid-north" ? north.grid : north.true),
  );

export const renderTitleblock = (svg: string, data: TemplateData, north: North): string =>
  applyNorth(renderTemplate(svg, data), north);
