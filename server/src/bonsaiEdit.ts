/**
 * Editing a sheet's view-title and titleblock values from SketchSpace.
 *
 * A placement on a board is an image, but the image was rendered from a template
 * the model fills in - `{{Name}}`, `{{Identification}}`, `{{Scale}}`. This is how
 * those values are typed back: the element says which layout and which group it
 * belongs to, Bonsai is asked what that view's fields hold and which of them it
 * can write, and an edit is sent to the Blender that has the model open.
 *
 * Nothing here writes to the `.ifc` or to the layout. Blender holds the model in
 * memory, so a write to the file would be invisible to it and lost on its next
 * save; and renaming a sheet moves its layout, renaming a drawing moves its SVG
 * and relinks every layout placing it - side effects only Bonsai performs. What
 * comes back is a file on disk changing, which the layout watcher already
 * follows, and new values on the next answer from the bridge.
 *
 * A view is named to Bonsai by its drawing's GlobalId and by the file it places.
 * Both are in the layout; the group's `data-id` is a STEP id and does not
 * survive a re-serialised model (IfcOpenShell#9468).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseLayout, type Placement } from "./bonsaiLayout.js";
import { askEditableFields, askToSetValues, type EditableField } from "./bonsaiBridge.js";
import { getLayoutValues, liveSourceForLayout } from "./ifcValues.js";
import { placeholdersIn } from "./templates.js";

/** What a board element carries about the placement it came from. */
export type ElementRef = {
  layout: string;
  groupKey: string;
  kind?: string;
  globalId?: string | null;
};

export type ViewFields = {
  /** The sheet this view is on, for the panel's heading. */
  sheet: string;
  /** "titleblock", or the name of the drawing the view-title belongs to. */
  view: string;
  /** Whether a Blender with this model open is there to answer. */
  connected: boolean;
  fields: EditableField[];
  /** Why nothing can be edited right now, when that is the case. */
  note?: string;
};

type Resolved = {
  /** The template whose placeholders are the fields on offer. */
  template: string;
  /** How Bonsai is told which view this is. */
  target: Record<string, unknown>;
};

/**
 * Which template a selected element edits, and which view that is in the model.
 *
 * Selecting the drawing rather than its title is the same request: they are one
 * group in the layout, and the title is what carries the fields.
 */
const resolve = (ref: ElementRef): Resolved => {
  const layout = parseLayout(ref.layout);
  const group = layout.placements.filter((p) => p.groupKey === ref.groupKey);
  if (group.length === 0) {
    throw new Error("this placement is no longer on the sheet");
  }

  if (group[0]!.kind === "titleblock") {
    return { template: group[0]!.href, target: { kind: "sheet" } };
  }

  const title = group.find((p) => p.role === "view-title");
  if (!title) {
    throw new Error("this drawing has no view-title to edit");
  }
  const content = group.find((p: Placement) => p.role !== "view-title");
  const target: Record<string, unknown> = { kind: "placement" };
  if (content) {
    target.path = content.href;
  }
  // Only a drawing's id is a GlobalId; a document group's data-document is a
  // STEP id, and Bonsai falls back to the file when it matches nothing.
  if (ref.globalId && ref.kind === "drawing") {
    target.globalId = ref.globalId;
  }
  return { template: title.href, target };
};

const describe = (ref: ElementRef, resolved: Resolved): { sheet: string; view: string } => ({
  sheet: path.basename(ref.layout, path.extname(ref.layout)),
  view:
    resolved.target.kind === "sheet"
      ? "titleblock"
      : path.basename(String(resolved.target.path ?? ""), ".svg") || "this view",
});

/**
 * What this view's fields hold according to the saved model - what is on the
 * sheet when no Blender is connected.
 */
const savedValues = (ref: ElementRef, resolved: Resolved): Record<string, string> => {
  const values = getLayoutValues(ref.layout);
  if (!values) {
    return {};
  }
  const data =
    resolved.target.kind === "sheet"
      ? values.titleblock
      : (resolved.target.path ? values.placement(String(resolved.target.path)) : undefined) ??
        (ref.globalId ? values.drawing(ref.globalId) : undefined);

  const text: Record<string, string> = {};
  for (const [name, value] of Object.entries(data ?? {})) {
    // A build prints "None" for an unset attribute and so does the sheet, but
    // in a box it reads as a value someone typed.
    text[name] = typeof value === "string" && value !== "None" ? value : "";
  }
  return text;
};

/** The fields a selected element offers, with whatever Bonsai can tell us. */
export const fieldsFor = async (ref: ElementRef): Promise<ViewFields> => {
  const resolved = resolve(ref);
  const { sheet, view } = describe(ref, resolved);
  const names = placeholdersIn(readFileSync(resolved.template, "utf8"));

  const source = liveSourceForLayout(ref.layout);
  if (!source) {
    // The values are on the sheet - they came from the saved file - and showing
    // them blank would read as a fault rather than as something to come back to.
    // The file is not where an edit can go, so they are shown and not offered.
    const values = savedValues(ref, resolved);
    return {
      sheet,
      view,
      connected: false,
      note: "Open this model in Blender to edit these values.",
      fields: names.map((name) => ({ name, value: values[name] ?? "", editable: false })),
    };
  }

  const fields = await askEditableFields(source, ref.layout, resolved.target, names);
  return { sheet, view, connected: true, fields };
};

/**
 * Apply typed values.
 *
 * Answers with the fields that changed and the layout's path afterwards - a
 * renamed sheet has moved, and the caller's next question is about the new one.
 */
export const setValues = async (
  ref: ElementRef,
  values: Record<string, string>,
): Promise<{ changed: string[]; layout: string }> => {
  const resolved = resolve(ref);
  const source = liveSourceForLayout(ref.layout);
  if (!source) {
    throw new Error("Blender is not connected - open this model in Blender to edit it");
  }
  return askToSetValues(source, ref.layout, resolved.target, values);
};
