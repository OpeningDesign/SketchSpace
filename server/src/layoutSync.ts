/**
 * Reconcile a page against its Bonsai layout.
 *
 * Bonsai writes the layout on add_drawing, remove_drawing, add_document, and the
 * two update_*_sizes reflows - so it both adds and *moves* placements. (build(),
 * i.e. create_sheets, only writes sheets/, never the layout.) Without this, a
 * drawing added in Bonsai would never appear here, and a reflow would be
 * silently reverted the next time SketchSpace wrote positions back.
 *
 * Conflict rule: the file changed externally, so Bonsai is the more recent
 * writer and its positions win. Same last-writer-wins shape the canvas already
 * uses for elements.
 *
 * Redlines are never touched: they carry no `customData.bonsai`, so nothing here
 * matches them.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writeAsset } from "./assets.js";
import { inlineNestedImages, MM_TO_PX, parseLayout } from "./bonsaiLayout.js";
import { newId, recordFile } from "./db.js";
import { indexBetween } from "./fracIndex.js";

import type { Placement } from "./bonsaiLayout.js";
import type { SyncElement } from "./types.js";

export type SyncSummary = {
  added: number;
  updated: number;
  removed: number;
  /** Elements to feed through the store; empty when nothing changed. */
  changed: SyncElement[];
};

/** A placement is identified within its page by group + role. */
const keyOf = (groupKey: string, role: string) => `${groupKey}::${role}`;

/**
 * SyncElement is deliberately loose - the server types only the fields
 * reconciliation is defined over. Imported placements are always images, so
 * narrow to the geometry we compare.
 */
type PlacedElement = SyncElement & {
  x: number;
  y: number;
  width: number;
  height: number;
  fileId: string | null;
};

/**
 * Store a linked SVG as a board file, inlining its own external references
 * first - a relative underlay reference dies once the SVG becomes a data: URL.
 */
const storeLinkedSvg = (href: string, boardId: string): string | null => {
  if (!existsSync(href)) {
    return null;
  }
  const { svg } = inlineNestedImages(readFileSync(href, "utf8"), path.dirname(href));
  const buf = Buffer.from(svg, "utf8");
  const fileId = createHash("sha256").update(buf).digest("hex").slice(0, 40);

  writeAsset(boardId, fileId, buf);
  recordFile(fileId, boardId, "image/svg+xml");
  return fileId;
};

const bonsaiMetaFor = (p: Placement, layoutPath: string) => ({
  kind: p.kind,
  role: p.role,
  globalId: p.globalId,
  stepId: p.stepId,
  groupKey: p.groupKey,
  imgX: p.imgX,
  imgY: p.imgY,
  groupTx: p.groupTx,
  groupTy: p.groupTy,
  layout: layoutPath,
  href: path.relative(path.dirname(layoutPath), p.href).replace(/\\/g, "/"),
});

export const placementToElement = (
  p: Placement,
  fileId: string,
  index: string,
  layoutPath: string,
): SyncElement =>
  ({
    id: newId(20),
    type: "image",
    x: Math.round(p.x * MM_TO_PX * 100) / 100,
    y: Math.round(p.y * MM_TO_PX * 100) / 100,
    width: Math.round(p.width * MM_TO_PX * 100) / 100,
    height: Math.round(p.height * MM_TO_PX * 100) / 100,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [`bonsai:${p.groupKey}`],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    index,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: p.locked,
    status: "saved",
    fileId,
    scale: [1, 1],
    crop: null,
    customData: { bonsai: bonsaiMetaFor(p, layoutPath) },
  }) as unknown as SyncElement;

/**
 * Diff a page's imported placements against the layout on disk.
 * Returns only the elements that need to change.
 */
export const syncPageWithLayout = (
  current: readonly SyncElement[],
  boardId: string,
  layoutPath: string,
): SyncSummary => {
  const layout = parseLayout(layoutPath);
  const changed: SyncElement[] = [];
  let added = 0;
  let updated = 0;
  let removed = 0;

  const mine = new Map<string, PlacedElement>();
  let maxIndex: string | null = null;
  for (const el of current) {
    const b = (el.customData as { bonsai?: Record<string, unknown> } | undefined)
      ?.bonsai;
    if (b?.layout === layoutPath && typeof b.groupKey === "string") {
      mine.set(keyOf(b.groupKey, String(b.role ?? "content")), el as PlacedElement);
    }
    if (typeof el.index === "string" && (maxIndex === null || el.index > maxIndex)) {
      maxIndex = el.index;
    }
  }

  const seen = new Set<string>();

  for (const p of layout.placements) {
    const key = keyOf(p.groupKey, p.role);
    seen.add(key);
    const existing = mine.get(key);

    if (!existing) {
      const fileId = storeLinkedSvg(p.href, boardId);
      if (!fileId) {
        continue;
      }
      maxIndex = indexBetween(maxIndex, null);
      changed.push(placementToElement(p, fileId, maxIndex, layoutPath));
      added++;
      continue;
    }

    const x = Math.round(p.x * MM_TO_PX * 100) / 100;
    const y = Math.round(p.y * MM_TO_PX * 100) / 100;
    const width = Math.round(p.width * MM_TO_PX * 100) / 100;
    const height = Math.round(p.height * MM_TO_PX * 100) / 100;

    const moved =
      Math.abs(existing.x - x) > 0.01 ||
      Math.abs(existing.y - y) > 0.01 ||
      Math.abs(existing.width - width) > 0.01 ||
      Math.abs(existing.height - height) > 0.01;

    // A placement we had marked deleted is back in the layout - a drawing
    // removed from a sheet and put back, or a bad sync being corrected. Without
    // this it stays deleted forever: the geometry matches, so nothing else here
    // would produce an update, and the element is never revived.
    const revived = existing.isDeleted === true;

    // A regenerated drawing changes bytes without necessarily moving, so the
    // stored image may be stale even when the geometry matches.
    const fileId = storeLinkedSvg(p.href, boardId);
    const refreshed = fileId !== null && fileId !== existing.fileId;

    if (!moved && !refreshed && !revived) {
      continue;
    }

    changed.push({
      ...existing,
      x,
      y,
      width,
      height,
      isDeleted: false,
      ...(fileId ? { fileId } : {}),
      version: existing.version + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
      customData: { bonsai: bonsaiMetaFor(p, layoutPath) },
    } as unknown as SyncElement);
    updated++;
  }

  // Anything we imported that the layout no longer has was deleted in Bonsai.
  for (const [key, el] of mine) {
    if (seen.has(key) || el.isDeleted) {
      continue;
    }
    changed.push({
      ...el,
      isDeleted: true,
      version: el.version + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    } as unknown as SyncElement);
    removed++;
  }

  return { added, updated, removed, changed };
};


/**
 * Repoint a page's placements at a renamed layout file.
 *
 * Bonsai renames the layout when a sheet is renamed, and a layout carries no
 * identity of its own - so matching on path alone sees a brand new sheet,
 * orphaning the old tab and duplicating it. Callers identify the rename by the
 * set of drawing GlobalIds; this rewrites the stored path so the page follows.
 */
export const rebindLayoutPath = (
  current: readonly SyncElement[],
  oldLayoutPath: string,
  newLayoutPath: string,
): SyncElement[] => {
  const changed: SyncElement[] = [];
  for (const el of current) {
    const b = (el.customData as { bonsai?: Record<string, unknown> } | undefined)
      ?.bonsai;
    if (!b || b.layout !== oldLayoutPath) {
      continue;
    }
    changed.push({
      ...el,
      customData: { bonsai: { ...b, layout: newLayoutPath } },
      version: el.version + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    } as unknown as SyncElement);
  }
  return changed;
};
