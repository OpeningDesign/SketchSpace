/**
 * Writes drawing positions from a board back into its Bonsai layout.
 *
 * Shared by the CLI (scripts/export-layout.mjs) and the in-app "Push to Bonsai"
 * button, so there is exactly one implementation of the rules below.
 *
 * A drawing is moved by its group `transform`, not its foreground's x/y, because
 * Bonsai's `build_drawings` copies each <g data-type="drawing"> into the built
 * sheet with its attributes intact - swapping only the <image> children - so the
 * transform survives the build. It is also what Inkscape writes when a group is
 * dragged, and it leaves the foreground's coordinates, which Bonsai re-centres on
 * every resize, alone.
 *
 * A view-title moved on its own is the one exception, and is written to the
 * title image's x/y. That offset is the title's position within its group:
 * `build_drawings` renders the title at it, `update_drawing_sizes` shifts rather
 * than recomputes it, and Inkscape writes the same thing when a title is dragged
 * inside its group.
 *
 * Every edit is string surgery on the attributes concerned. Re-serialising the
 * XML would reformat the whole file and destroy the small, readable git diff
 * that is the entire reason layouts exist.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { MM_TO_PX } from "./bonsaiLayout.js";
import { listPages } from "./db.js";
import { noteSelfWrite } from "./layoutWatcher.js";
import { applyUpdate, getElements } from "./store.js";

import type { SyncElement } from "./types.js";

/** Positions must differ by more than this (mm) to be worth writing. */
const EPSILON = 0.01;

/** A sibling that was dragged away from its group; we only write the group offset. */
const INDEPENDENT_MOVE_TOLERANCE = 0.5;

/**
 * How long a placement must sit still before its position is written to the
 * layout. Long enough to coalesce a drag, short enough to feel automatic - and
 * it keeps write churn down on a Dropbox-synced project tree.
 */
const AUTOSAVE_MS = 2000;

export type MovedDrawing = {
  groupKey: string;
  globalId: string | null;
  kind: string;
  /** Millimetres, relative to where the layout currently has it. */
  dx: number;
  dy: number;
  /** The view-title was moved relative to its drawing, and that was written. */
  titleMoved: boolean;
  warnings: string[];
};

export type LayoutPush = {
  layoutPath: string;
  pageName: string;
  moved: MovedDrawing[];
};

export type PushResult = {
  written: boolean;
  layouts: LayoutPush[];
  errors: string[];
  /** Total drawings that would move / did move. */
  total: number;
  /**
   * Elements whose stored baseline was refreshed to match what we just wrote,
   * keyed by page. Callers broadcast these so open clients stay in step.
   */
  refreshed: { pageId: string; elements: SyncElement[] }[];
};

type BonsaiMeta = {
  groupKey?: string;
  layout?: string;
  globalId?: string | null;
  kind?: string;
  role?: string;
  imgX?: number;
  imgY?: number;
  groupTx?: number;
  groupTy?: number;
};

type SceneElement = {
  x: number;
  y: number;
  version: number;
  isDeleted?: boolean;
  customData?: { bonsai?: BonsaiMeta };
};

/* ---------------------------- string surgery ----------------------------- */

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Locate one drawing group - its opening tag through the matching `</g>`.
 *
 * `\bid=` also matches inside `data-id=`, which is what finds Bonsai's groups:
 * they carry no `id` of their own, so the parser falls back to `data-id` for the
 * key. Kept as it was; see NOTES.md.
 */
const findGroup = (svg: string, groupKey: string): { start: number; end: number } | null => {
  const open = new RegExp(`<g\\b[^>]*\\bid="${escapeRegExp(groupKey)}"[^>]*>`).exec(svg);
  if (!open) {
    return null;
  }
  const start = open.index;
  if (open[0].endsWith("/>")) {
    return { start, end: start + open[0].length };
  }

  let depth = 1;
  const tags = /<g\b[^>]*?(\/?)>|<\/g\s*>/g;
  tags.lastIndex = start + open[0].length;
  for (let m = tags.exec(svg); m; m = tags.exec(svg)) {
    if (m[0].startsWith("</")) {
      depth--;
    } else if (m[1] !== "/") {
      depth++;
    }
    if (depth === 0) {
      return { start, end: m.index + m[0].length };
    }
  }
  return null;
};

/** Set one attribute on a tag, by whole name - `x` must not hit `data-x`. */
const setAttr = (tag: string, name: string, value: string): string => {
  const re = new RegExp(`(\\s)${escapeRegExp(name)}\\s*=\\s*"[^"]*"`);
  return re.test(tag)
    ? tag.replace(re, `$1${name}="${value}"`)
    : tag.replace(/(\s*\/?>)$/, ` ${name}="${value}"$1`);
};

/** A group with no transform yet gets one first, as Inkscape writes it. */
const setGroupTransform = (group: string, transform: string): string => {
  const end = group.indexOf(">") + 1;
  const tag = group.slice(0, end);
  const next = /\stransform\s*=\s*"[^"]*"/.test(tag)
    ? setAttr(tag, "transform", transform)
    : tag.replace(/^<g\b/, `<g transform="${transform}"`);
  return next + group.slice(end);
};

/** Rewrite the x/y of the group's view-title image, or null if it has none. */
const setViewTitlePosition = (group: string, x: number, y: number): string | null => {
  const m = /<image\b[^>]*\bdata-type\s*=\s*"view-title"[^>]*>/.exec(group);
  if (!m) {
    return null;
  }
  const tag = setAttr(setAttr(m[0], "x", x.toFixed(6)), "y", y.toFixed(6));
  return group.slice(0, m.index) + tag + group.slice(m.index + m[0].length);
};

/**
 * @param write when false, computes the moves without touching any file.
 */
export const pushBoardToLayouts = (
  boardId: string,
  write: boolean,
): PushResult => {
  const layouts: LayoutPush[] = [];
  const errors: string[] = [];
  const refreshed: PushResult["refreshed"] = [];
  let total = 0;

  for (const page of listPages(boardId)) {
    // Read through the store, not the database: a move made seconds ago may not
    // have passed the persistence debounce yet.
    const elements = getElements(page.id) as unknown as SceneElement[];

    const groups = new Map<string, SceneElement[]>();
    for (const el of elements) {
      const b = el.customData?.bonsai;
      if (el.isDeleted || !b?.groupKey || !b.layout) {
        continue; // a redline, or an import that predates write-back metadata
      }
      const list = groups.get(b.groupKey);
      if (list) {
        list.push(el);
      } else {
        groups.set(b.groupKey, [el]);
      }
    }
    if (groups.size === 0) {
      continue;
    }

    const layoutPath = [...groups.values()][0]![0]!.customData!.bonsai!.layout!;
    if (!existsSync(layoutPath)) {
      errors.push(`layout not found: ${layoutPath}`);
      continue;
    }

    let svg = readFileSync(layoutPath, "utf8");
    const moved: MovedDrawing[] = [];
    const rebased: SyncElement[] = [];

    for (const [groupKey, els] of groups) {
      // Anchor on the drawing, never on its title. The title is positioned
      // relative to the drawing, so letting it lead would drag the whole drawing
      // whenever only the title was moved.
      const anchor =
        els.find((el) => el.customData!.bonsai!.role !== "view-title") ?? els[0]!;
      const b = anchor.customData!.bonsai!;
      const warnings: string[] = [];

      // Where the group must now sit: current position minus the image's own
      // offset, which Bonsai owns and we must not disturb.
      const tx = anchor.x / MM_TO_PX - (b.imgX ?? 0);
      const ty = anchor.y / MM_TO_PX - (b.imgY ?? 0);
      const dx = tx - (b.groupTx ?? 0);
      const dy = ty - (b.groupTy ?? 0);
      const groupMoved = Math.abs(dx) >= EPSILON || Math.abs(dy) >= EPSILON;

      // The group offset everything else is measured against. When the drawing
      // did not move, keep the stored value exactly rather than one re-derived
      // from rounded pixel coordinates.
      const gx = groupMoved ? tx : (b.groupTx ?? 0);
      const gy = groupMoved ? ty : (b.groupTy ?? 0);

      // A view-title moved relative to its drawing is written to the title's own
      // x/y. Bonsai honours that offset - build_drawings renders the title at it,
      // and update_drawing_sizes shifts it rather than recomputing it - and it is
      // what Inkscape writes when a title is dragged inside its group. Anything
      // else that strays from its group still snaps back, as before.
      const titles: { el: SceneElement; ix: number; iy: number }[] = [];
      for (const el of els) {
        if (el === anchor) {
          continue;
        }
        const s = el.customData!.bonsai!;
        const ix = el.x / MM_TO_PX - gx;
        const iy = el.y / MM_TO_PX - gy;
        const offX = Math.abs(ix - (s.imgX ?? 0));
        const offY = Math.abs(iy - (s.imgY ?? 0));

        if (s.role === "view-title") {
          if (offX >= EPSILON || offY >= EPSILON) {
            titles.push({ el, ix, iy });
          }
        } else if (offX > INDEPENDENT_MOVE_TOLERANCE || offY > INDEPENDENT_MOVE_TOLERANCE) {
          warnings.push(
            `"${s.role ?? "sibling"}" was moved separately; it will snap back to the group`,
          );
        }
      }

      if (!groupMoved && titles.length === 0) {
        continue;
      }

      const span = findGroup(svg, groupKey);
      if (!span) {
        errors.push(`no <g id="${groupKey}"> in ${layoutPath}`);
        continue;
      }

      let group = svg.slice(span.start, span.end);
      if (groupMoved) {
        group = setGroupTransform(group, `translate(${tx.toFixed(6)},${ty.toFixed(6)})`);
      }

      const titlesWritten = new Map<SceneElement, { ix: number; iy: number }>();
      for (const t of titles) {
        const next = setViewTitlePosition(group, t.ix, t.iy);
        if (next === null) {
          warnings.push(`no view-title <image> in group ${groupKey}; the title's move was not saved`);
          continue;
        }
        group = next;
        titlesWritten.set(t.el, { ix: t.ix, iy: t.iy });
      }

      svg = svg.slice(0, span.start) + group + svg.slice(span.end);

      moved.push({
        groupKey,
        globalId: b.globalId ?? null,
        kind: b.kind ?? "drawing",
        dx: groupMoved ? dx : 0,
        dy: groupMoved ? dy : 0,
        titleMoved: titlesWritten.size > 0,
        warnings,
      });

      // The layout now holds these values, so they become the new baseline.
      // Without this the same delta stays "pending" forever and every
      // subsequent autosave rewrites it - our own writes are echo-suppressed,
      // so the watcher will not refresh it for us.
      for (const el of els) {
        const title = titlesWritten.get(el);
        rebased.push({
          ...el,
          customData: {
            ...(el.customData ?? {}),
            bonsai: {
              ...el.customData!.bonsai!,
              groupTx: gx,
              groupTy: gy,
              ...(title ? { imgX: title.ix, imgY: title.iy } : {}),
            },
          },
          version: el.version + 1,
          versionNonce: Math.floor(Math.random() * 2 ** 31),
        } as unknown as SyncElement);
      }
    }

    if (moved.length === 0) {
      continue;
    }
    if (write) {
      // Record the hash before writing so the file watcher recognises this as
      // our own change and does not bounce it straight back as an edit.
      noteSelfWrite(layoutPath, svg);
      writeFileSync(layoutPath, svg, "utf8");

      const accepted = applyUpdate(page.id, rebased);
      if (accepted.length > 0) {
        refreshed.push({ pageId: page.id, elements: accepted });
      }
    }
    total += moved.length;
    layouts.push({ layoutPath, pageName: page.name, moved });
  }

  return { written: write, layouts, errors, total, refreshed };
};


/* ------------------------------- autosave -------------------------------- */

const pending = new Map<string, NodeJS.Timeout>();

/**
 * Write moved placements back to the layout, debounced.
 *
 * Safe to do continuously only because the layout watcher keeps our baseline
 * fresh: without it, a stale `groupTx` would silently revert a reflow Bonsai had
 * just made. The write is also surgical - it rewrites only the `<g id>` tags it
 * knows about - so a drawing Bonsai just added is left untouched.
 *
 * Redlines never reach here; they carry no `customData.bonsai`.
 */
export const scheduleLayoutAutosave = (
  boardId: string,
  onWritten: (result: PushResult) => void,
): void => {
  clearTimeout(pending.get(boardId));
  pending.set(
    boardId,
    setTimeout(() => {
      pending.delete(boardId);
      try {
        const result = pushBoardToLayouts(boardId, true);
        if (result.total > 0) {
          console.log(
            `[sketchspace] layout autosave ${boardId}: wrote ${result.total} placement(s)`,
          );
          onWritten(result);
        }
        // Autosave has no one to show these to, so they go to the log. A move
        // that is dropped without a trace is indistinguishable from a bug.
        for (const layout of result.layouts) {
          for (const m of layout.moved) {
            for (const w of m.warnings) {
              console.warn(`[sketchspace] layout autosave ${layout.pageName}: ${w}`);
            }
          }
        }
        for (const e of result.errors) {
          console.warn(`[sketchspace] layout autosave ${boardId}: ${e}`);
        }
      } catch (error) {
        console.error(`[sketchspace] layout autosave failed for ${boardId}:`, error);
      }
    }, AUTOSAVE_MS),
  );
};

/** Flush any pending autosave immediately - used on shutdown. */
export const flushLayoutAutosaves = (): void => {
  for (const [boardId, timer] of pending) {
    clearTimeout(timer);
    try {
      pushBoardToLayouts(boardId, true);
    } catch {
      // Best effort on the way out.
    }
  }
  pending.clear();
};
