/**
 * Writes drawing positions from a board back into its Bonsai layout.
 *
 * Shared by the CLI (scripts/export-layout.mjs) and the in-app "Push to Bonsai"
 * button, so there is exactly one implementation of the rules below.
 *
 * Writes the group `transform`, not the image x/y, because Bonsai's
 * `build_drawings` copies each <g data-type="drawing"> into the built sheet with
 * its attributes intact - swapping only the <image> children - so the transform
 * survives the build. It is also what Inkscape writes when a group is dragged,
 * and it leaves Bonsai's own coordinates and reflow logic untouched.
 *
 * The edit is string surgery on the single attribute. Re-serialising the XML
 * would reformat the whole file and destroy the small, readable git diff that is
 * the entire reason layouts exist.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { MM_TO_PX } from "./bonsaiLayout.js";
import { listPages } from "./db.js";
import { getElements } from "./store.js";

/** Positions must differ by more than this (mm) to be worth writing. */
const EPSILON = 0.01;

/** A sibling that was dragged away from its group; we only write the group offset. */
const INDEPENDENT_MOVE_TOLERANCE = 0.5;

export type MovedDrawing = {
  groupKey: string;
  globalId: string | null;
  kind: string;
  /** Millimetres, relative to where the layout currently has it. */
  dx: number;
  dy: number;
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
  isDeleted?: boolean;
  customData?: { bonsai?: BonsaiMeta };
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

    for (const [groupKey, els] of groups) {
      const first = els[0]!;
      const b = first.customData!.bonsai!;
      const warnings: string[] = [];

      // Where the group must now sit: current position minus the image's own
      // offset, which Bonsai owns and we must not disturb.
      const tx = first.x / MM_TO_PX - (b.imgX ?? 0);
      const ty = first.y / MM_TO_PX - (b.imgY ?? 0);
      const dx = tx - (b.groupTx ?? 0);
      const dy = ty - (b.groupTy ?? 0);

      if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) {
        continue;
      }

      for (const el of els.slice(1)) {
        const s = el.customData!.bonsai!;
        const sx = el.x / MM_TO_PX - (s.imgX ?? 0) - (s.groupTx ?? 0);
        const sy = el.y / MM_TO_PX - (s.imgY ?? 0) - (s.groupTy ?? 0);
        if (
          Math.abs(sx - dx) > INDEPENDENT_MOVE_TOLERANCE ||
          Math.abs(sy - dy) > INDEPENDENT_MOVE_TOLERANCE
        ) {
          warnings.push(
            `"${s.role ?? "sibling"}" was moved separately; it will snap back to the group`,
          );
        }
      }

      const transform = `translate(${tx.toFixed(6)},${ty.toFixed(6)})`;
      const tagRe = new RegExp(`<g\\b[^>]*\\bid="${groupKey}"[^>]*>`);
      const tag = tagRe.exec(svg);
      if (!tag) {
        errors.push(`no <g id="${groupKey}"> in ${layoutPath}`);
        continue;
      }

      const updated = /\btransform\s*=\s*"[^"]*"/.test(tag[0])
        ? tag[0].replace(/\btransform\s*=\s*"[^"]*"/, `transform="${transform}"`)
        : tag[0].replace(/^<g\b/, `<g transform="${transform}"`);
      svg = svg.replace(tag[0], updated);

      moved.push({
        groupKey,
        globalId: b.globalId ?? null,
        kind: b.kind ?? "drawing",
        dx,
        dy,
        warnings,
      });
    }

    if (moved.length === 0) {
      continue;
    }
    if (write) {
      writeFileSync(layoutPath, svg, "utf8");
    }
    total += moved.length;
    layouts.push({ layoutPath, pageName: page.name, moved });
  }

  return { written: write, layouts, errors, total };
};
