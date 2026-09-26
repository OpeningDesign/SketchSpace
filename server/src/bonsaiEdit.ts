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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { MM_TO_PX, parseLayout, type Placement } from "./bonsaiLayout.js";
import {
  askEditableFields,
  askForDrawings,
  askToAddToSheet,
  askToRemoveFromSheet,
  askToSetValues,
  type BonsaiDrawing,
  type EditableField,
} from "./bonsaiBridge.js";
import { listPages } from "./db.js";
import { getLayoutValues, liveSourceForLayout } from "./ifcValues.js";
import { getElements } from "./store.js";
import { normalisePath } from "./paths.js";
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

/**
 * A titleblock's fields, with the choice of which site and building fill them.
 *
 * `{{SiteTown}}` on a sheet means the town of the site that sheet is about, and
 * the sheet says which one - Bonsai answers `Site` and `Building` with the list
 * to pick from. They are offered only where the template shows something of
 * theirs: a titleblock with no address has nothing for the choice to change.
 * Not offered from the saved file, where nothing could be chosen anyway.
 */
const withLinks = (resolved: Resolved, names: string[]): string[] => {
  if (resolved.target.kind !== "sheet") {
    return names;
  }
  const links = ["Site", "Building"].filter(
    (prefix) => !names.includes(prefix) && names.some((name) => name.startsWith(prefix)),
  );
  return [...links, ...names];
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

  const fields = await askEditableFields(source, ref.layout, resolved.target, withLinks(resolved, names));
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

/* ------------------------ deleting from the sheet ------------------------ */

/**
 * Deleting a drawing here has to reach Bonsai, or it does not stick.
 *
 * The layout still places it, so `syncPageWithLayout` revives the element the
 * next time the sheet is read - the drawing comes back, which looks like the
 * delete was ignored. Bonsai is the one that can take it off: it removes the
 * sheet's reference and the group from the layout, the watcher picks that up,
 * and the element stays gone because nothing places it any more.
 *
 * Only the sheet's reference to the drawing goes. The drawing itself - its
 * annotation, its camera, its SVG - is untouched, and so is any other sheet
 * placing it. That is `bim.remove_drawing_from_sheet`, not a delete.
 */
const REMOVAL_DEBOUNCE_MS = 4000;
const pendingRemovals = new Map<string, NodeJS.Timeout>();

/**
 * Groups the layout still places whose every element on the page is deleted.
 *
 * Asking the layout rather than remembering what we sent keeps this
 * self-limiting: once Bonsai has removed the group, the layout no longer has
 * it and there is nothing left to ask for. A group with no elements at all is
 * not a deletion - it was never synced.
 */
const deletedGroups = (layoutPath: string, elements: readonly SceneElement[]): string[] => {
  const alive = new Map<string, boolean>();
  for (const el of elements) {
    const meta = (el.customData as { bonsai?: { groupKey?: string } } | undefined)?.bonsai;
    if (!meta?.groupKey) {
      continue;
    }
    alive.set(meta.groupKey, (alive.get(meta.groupKey) ?? false) || !el.isDeleted);
  }

  const gone = new Set<string>();
  for (const p of parseLayout(layoutPath).placements) {
    // The titleblock is locked and Bonsai refuses to remove it anyway.
    if (p.kind !== "titleblock" && alive.get(p.groupKey) === false) {
      gone.add(p.groupKey);
    }
  }
  return [...gone];
};

type SceneElement = {
  isDeleted?: boolean;
  x?: number;
  y?: number;
  role?: string;
  customData?: {
    bonsai?: { layout?: string; groupKey?: string; kind?: string; globalId?: string | null; role?: string };
  };
};

/**
 * Tell Bonsai about drawings deleted on this board, once the dust settles.
 *
 * Debounced longer than the layout autosave: this is not reversible from here,
 * and the seconds are what let an undo land before anything is asked of the
 * model.
 */
export const scheduleSheetRemovals = (boardId: string): void => {
  clearTimeout(pendingRemovals.get(boardId));
  pendingRemovals.set(
    boardId,
    setTimeout(() => {
      pendingRemovals.delete(boardId);
      void applySheetRemovals(boardId);
    }, REMOVAL_DEBOUNCE_MS),
  );
};

const applySheetRemovals = async (boardId: string): Promise<void> => {
  for (const page of listPages(boardId)) {
    // Through the store, not the database: a delete made seconds ago may not
    // have passed the persistence debounce yet.
    const elements = getElements(page.id) as unknown as SceneElement[];
    const layoutPath = elements
      .map((el) => el.customData?.bonsai?.layout)
      .find((l): l is string => Boolean(l));
    if (!layoutPath || !existsSync(layoutPath)) {
      continue;
    }

    let groups: string[];
    try {
      groups = deletedGroups(layoutPath, elements);
      // An undo is the other half of the same question, and asks the same two
      // things of the same two places - so it is answered in the same pass.
      await applySheetRevivals(layoutPath, elements);
    } catch (error) {
      console.warn(`[sketchspace] could not read ${path.basename(layoutPath)}: ${(error as Error).message}`);
      continue;
    }
    if (groups.length === 0) {
      continue;
    }

    const source = liveSourceForLayout(layoutPath);
    if (!source) {
      // Nothing can be done about it, and the drawing will be back on the next
      // sync - so say why rather than letting that look like a fault.
      console.warn(
        `[sketchspace] ${groups.length} drawing(s) deleted on ${path.basename(layoutPath)}, ` +
          `but no Blender has this model open - they will come back. ` +
          `Open it in Blender and delete them again to remove them from the sheet.`,
      );
      continue;
    }

    for (const groupKey of groups) {
      const meta = elements.find(
        (el) => el.customData?.bonsai?.groupKey === groupKey,
      )?.customData?.bonsai;
      try {
        const { removed, target } = await removeFromSheet({
          layout: layoutPath,
          groupKey,
          kind: meta?.kind,
          globalId: meta?.globalId ?? null,
        });
        remember(layoutPath, groupKey, target, whereItSat(elements, groupKey), numberOf(layoutPath, target));
        console.log(
          `[sketchspace] removed ${removed || groupKey} from ${path.basename(layoutPath)} in Bonsai`,
        );
      } catch (error) {
        console.warn(
          `[sketchspace] could not remove ${groupKey} from ${path.basename(layoutPath)}: ` +
            (error as Error).message,
        );
      }
    }
  }
};

/* ------------------------------ undoing that ----------------------------- */

/**
 * What we took off a sheet, so that undoing in the browser can put it back.
 *
 * Only our own removals: a drawing taken off in Bonsai also leaves an element
 * alive for a moment before the sync marks it deleted, and re-adding that
 * would be SketchSpace arguing with Bonsai about a decision Bonsai made. So
 * this is a record of what we did, not a rule about what a sheet should hold -
 * which is also why it expires. Undo is about the thing you just did.
 */
type Removal = {
  target: Record<string, unknown>;
  position: { x: number; y: number } | null;
  identification: string | null;
  at: number;
};

const UNDO_WINDOW_MS = 10 * 60_000;
const removedByUs = new Map<string, Removal>();

const keyOf = (layout: string, groupKey: string) => `${normalisePath(layout)}|${groupKey}`;

const remember = (
  layout: string,
  groupKey: string,
  target: Record<string, unknown>,
  position: { x: number; y: number } | null,
  identification: string | null,
) => {
  removedByUs.set(keyOf(layout, groupKey), { target, position, identification, at: Date.now() });
};

/**
 * Where a group's drawing sits now, in millimetres.
 *
 * From the element rather than its stored baseline, which the autosave may not
 * have caught up with - a drawing moved and then deleted should come back
 * where it was left, not where it was last written.
 */
const whereItSat = (
  elements: readonly SceneElement[],
  groupKey: string,
): { x: number; y: number } | null => {
  const image = elements.find(
    (el) =>
      el.customData?.bonsai?.groupKey === groupKey && el.customData.bonsai.role !== "view-title",
  );
  return image && typeof image.x === "number" && typeof image.y === "number"
    ? { x: image.x / MM_TO_PX, y: image.y / MM_TO_PX }
    : null;
};

/** The view number the drawing had, so it comes back called what it was. */
const numberOf = (layout: string, target: Record<string, unknown>): string | null => {
  const values = getLayoutValues(layout);
  const data = target.path ? values?.placement(String(target.path)) : undefined;
  const identification = data?.Identification;
  return identification && identification !== "None" ? identification : null;
};

/**
 * Put back anything we removed whose element is alive again - an undo.
 *
 * The element coming back is the signal, and the layout not placing it is what
 * says the removal has already happened. Both have to hold: within the
 * debounce an undo simply cancels the removal before it is sent, and no undo
 * is needed here.
 */
const applySheetRevivals = async (
  layoutPath: string,
  elements: readonly SceneElement[],
): Promise<void> => {
  const now = Date.now();
  const placed = new Set(parseLayout(layoutPath).placements.map((p) => p.groupKey));

  for (const [key, removal] of [...removedByUs]) {
    if (now - removal.at > UNDO_WINDOW_MS) {
      removedByUs.delete(key);
      continue;
    }
    const [layoutKey, groupKey] = key.split("|");
    if (layoutKey !== normalisePath(layoutPath) || placed.has(groupKey!)) {
      // Back on the sheet by some other route; nothing of ours to undo.
      if (placed.has(groupKey!)) {
        removedByUs.delete(key);
      }
      continue;
    }
    const alive = elements.some(
      (el) => !el.isDeleted && el.customData?.bonsai?.groupKey === groupKey,
    );
    if (!alive) {
      continue;
    }

    try {
      const added = await addToSheet(
        layoutPath,
        removal.target,
        removal.position,
        removal.identification,
      );
      removedByUs.delete(key);
      console.log(
        `[sketchspace] put ${added || groupKey} back on ${path.basename(layoutPath)} in Bonsai`,
      );
    } catch (error) {
      console.warn(
        `[sketchspace] could not put ${groupKey} back on ${path.basename(layoutPath)}: ` +
          (error as Error).message,
      );
    }
  }
};

/**
 * Take one view off its sheet, through Bonsai.
 *
 * Answers with the file removed and the target it was named by - an undo has
 * to name the same drawing, and by then the layout no longer places it, so it
 * cannot be resolved from the layout a second time.
 */
export const removeFromSheet = async (
  ref: ElementRef,
): Promise<{ removed: string; target: Record<string, unknown> }> => {
  const resolved = resolve(ref);
  const source = liveSourceForLayout(ref.layout);
  if (!source) {
    throw new Error("Blender is not connected - open this model in Blender to change it");
  }
  const { removed, stillPlaced } = await askToRemoveFromSheet(source, ref.layout, resolved.target);
  if (stillPlaced) {
    // Bonsai took the reference out of the model but could not find the group,
    // so the sheet still shows the drawing. Calling that done is how it went
    // unnoticed until a sheet had one drawing placed three times.
    throw new Error(
      `${removed || "that drawing"} was removed from the model but the layout still places it - ` +
        `Bonsai could not find its group. The sheet and the model now disagree.`,
    );
  }
  return { removed, target: resolved.target };
};

/**
 * What a sheet could have added to it.
 *
 * The whole model's drawings, each saying whether this sheet already places it
 * and whether it has been generated - both are reasons a person cannot pick it,
 * and both are better shown than discovered on pressing OK.
 */
export const drawingsFor = async (
  layout: string,
): Promise<{ connected: boolean; drawings: BonsaiDrawing[] }> => {
  const source = liveSourceForLayout(layout);
  if (!source) {
    return { connected: false, drawings: [] };
  }
  return { connected: true, drawings: await askForDrawings(source, layout) };
};

/**
 * Place a drawing on a sheet at a point on the canvas.
 *
 * The same request undo uses, with no view number: this is a new placement, so
 * Bonsai numbers it next as it would for its own Add Drawing To Sheet.
 */
export const placeDrawing = async (
  layout: string,
  globalId: string,
  position: { x: number; y: number },
): Promise<string> => addToSheet(layout, { globalId }, position, null);

/** Put one view back on its sheet, where it was. Resolves with the file added. */
export const addToSheet = async (
  layout: string,
  target: Record<string, unknown>,
  position: { x: number; y: number } | null,
  identification: string | null,
): Promise<string> => {
  const source = liveSourceForLayout(layout);
  if (!source) {
    throw new Error("Blender is not connected - open this model in Blender to change it");
  }
  return askToAddToSheet(source, layout, target, position, identification);
};
