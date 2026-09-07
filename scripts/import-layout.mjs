/**
 * Spike: import a Bonsai layout as a SketchSpace board.
 *
 *   npm run import:layout -- "D:/.../Bonsai/layouts/A001 - SITE PLAN.svg"
 *
 * Reads the layout (not the built sheet), resolves each linked drawing SVG,
 * stores them as SketchSpace image files, and writes one page whose elements
 * reproduce the layout's arrangement.
 *
 * Every element carries `customData.bonsai` with the IFC GlobalId, so a redline
 * placed here can later be anchored to the model rather than to pixels.
 *
 * This is a one-way read for now: nothing is written back to the layout.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  inlineNestedImages,
  MM_TO_PX,
  parseLayout,
} from "../dist/server/bonsaiLayout.js";
import { config } from "../dist/server/config.js";
import { createBoard, newId, recordFile, saveSceneJSON } from "../dist/server/db.js";
import { indexBetween } from "../dist/server/fracIndex.js";

const layoutPath = process.argv[2];
if (!layoutPath) {
  console.error("\nusage: npm run import:layout -- <path to layout .svg>\n");
  process.exit(1);
}
if (!existsSync(layoutPath)) {
  console.error(`\nno such file: ${layoutPath}\n`);
  process.exit(1);
}

const layout = parseLayout(layoutPath);

console.log(`\nlayout : ${layout.name}`);
console.log(`size   : ${layout.widthMm} x ${layout.heightMm} mm`);
console.log(`links  : ${layout.placements.length}\n`);

const { board, page } = createBoard(layout.name);
const filesDir = path.join(config.dataDir, "files");

const elements = [];
let index = null;
let skipped = 0;
let underlaysInlined = 0;
const brokenRefs = [];

for (const p of layout.placements) {
  if (!existsSync(p.href)) {
    console.log(`  MISSING  ${p.role.padEnd(11)} ${path.basename(p.href)}`);
    skipped++;
    continue;
  }

  // A drawing may reference a raster underlay relatively; that reference dies
  // the moment we base64 the SVG, so fold those in first.
  const raw = readFileSync(p.href, "utf8");
  const { svg, inlined, missing: unresolved } = inlineNestedImages(
    raw,
    path.dirname(p.href),
  );
  underlaysInlined += inlined;
  for (const u of unresolved) {
    brokenRefs.push(`${path.basename(p.href)} -> ${u}`);
  }

  const buf = Buffer.from(svg, "utf8");
  // Deterministic id from content, so re-importing reuses the same file.
  const fileId = createHash("sha256").update(buf).digest("hex").slice(0, 40);
  const dataURL = `data:image/svg+xml;base64,${buf.toString("base64")}`;

  writeFileSync(path.join(filesDir, `${board.id}.${fileId}`), dataURL, "utf8");
  recordFile(fileId, board.id, "image/svg+xml");

  index = indexBetween(index, null);

  elements.push({
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
    // Sibling images of one layout <g> (foreground + view-title) are bound into
    // an Excalidraw group so dragging moves them together, exactly as selecting
    // the group would in Inkscape.
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
    // Bonsai marks the titleblock sodipodi:insensitive; honour that here so it
    // cannot be nudged while redlining.
    locked: p.locked,
    status: "saved",
    fileId,
    scale: [1, 1],
    crop: null,
    customData: {
      bonsai: {
        kind: p.kind,
        role: p.role,
        globalId: p.globalId,
        stepId: p.stepId,
        groupKey: p.groupKey,
        // Origin state, so write-back can compute a delta without re-reading the
        // layout: the image's own coords and the group's translate at import.
        imgX: p.imgX,
        imgY: p.imgY,
        groupTx: p.groupTx,
        groupTy: p.groupTy,
        layout: layoutPath,
        href: path.relative(path.dirname(layoutPath), p.href).replace(/\\/g, "/"),
      },
    },
  });

  const id = p.globalId ? ` [${p.globalId}]` : "";
  console.log(
    `  ok       ${p.role.padEnd(11)} ${path.basename(p.href).slice(0, 44).padEnd(46)}` +
      `${(buf.length / 1024).toFixed(0).padStart(5)} KB${id}` +
      `${inlined ? `  +${inlined} inlined` : ""}`,
  );
}

saveSceneJSON(page.id, JSON.stringify(elements));

console.log(
  `\nimported ${elements.length} elements` +
    `${skipped ? `, ${skipped} missing` : ""}` +
    `, ${underlaysInlined} nested image(s) inlined`,
);
for (const b of brokenRefs) {
  console.log(`  UNRESOLVED  ${b}`);
}
console.log(`board    ${board.name}`);
console.log(`open     http://localhost:${config.port}/#/board/${board.id}\n`);
