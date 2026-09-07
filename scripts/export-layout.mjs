/**
 * Write drawing positions from a SketchSpace board back into its Bonsai layout.
 *
 *   npm run export:layout -- <boardId>
 *   npm run export:layout -- <boardId> --dry-run
 *
 * Writes the group `transform`, not the image x/y, because:
 *
 *   - `build_drawings` in Bonsai's sheeter.py copies each <g data-type="drawing">
 *     into the built sheet with its attributes intact, swapping only the <image>
 *     children for inlined content. The group transform therefore survives the
 *     build. Image x/y is separately folded into an inner translate.
 *   - It is what Inkscape does when you drag a group, so it is the established
 *     convention for "a human moved this".
 *   - It leaves Bonsai's own x/y - and the reflow logic in next_drawing_location
 *     and the height-delta adjustments - operating on coordinates it owns.
 *
 * The edit is deliberately string surgery on the one attribute rather than an
 * XML round-trip. Re-serialising would reformat the whole file and destroy the
 * small, readable git diff that is the entire reason layouts exist.
 *
 * Run `bpy.ops.bim.create_sheets()` in Blender afterwards to rebuild the sheet.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { MM_TO_PX } from "../dist/server/bonsaiLayout.js";
import { db } from "../dist/server/db.js";

const boardId = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!boardId) {
  console.error("\nusage: npm run export:layout -- <boardId> [--dry-run]\n");
  process.exit(1);
}

const board = db.prepare("SELECT id, name FROM boards WHERE id = ?").get(boardId);
if (!board) {
  console.error(`\nno board ${boardId}\n`);
  process.exit(1);
}

const pages = db
  .prepare("SELECT id, name FROM pages WHERE board_id = ? AND deleted = 0 ORDER BY frac_index")
  .all(board.id);

/** Positions only need to differ by more than this (mm) to be worth writing. */
const EPSILON = 0.01;

let totalMoved = 0;
const touchedLayouts = new Set();

for (const page of pages) {
  const row = db.prepare("SELECT elements FROM page_scenes WHERE page_id = ?").get(page.id);
  if (!row) {
    continue;
  }
  const elements = JSON.parse(row.elements).filter((e) => !e.isDeleted);

  // One layout group may own several elements (foreground + view-title). Any of
  // them yields the same delta, so take the first and check the rest agree.
  const groups = new Map();
  for (const el of elements) {
    const b = el.customData?.bonsai;
    if (!b?.groupKey || !b.layout) {
      continue; // a redline, not an imported placement
    }
    if (!groups.has(b.groupKey)) {
      groups.set(b.groupKey, []);
    }
    groups.get(b.groupKey).push(el);
  }

  if (groups.size === 0) {
    continue;
  }

  const layoutPath = [...groups.values()][0][0].customData.bonsai.layout;
  if (!existsSync(layoutPath)) {
    console.error(`  layout missing: ${layoutPath}`);
    continue;
  }

  let svg = readFileSync(layoutPath, "utf8");
  let moved = 0;

  console.log(`\npage "${page.name}"  ->  ${layoutPath}`);

  for (const [groupKey, els] of groups) {
    const b = els[0].customData.bonsai;

    // Where the group must now sit: current position, minus the image's own
    // offset, which Bonsai owns and we must not disturb.
    const tx = els[0].x / MM_TO_PX - b.imgX;
    const ty = els[0].y / MM_TO_PX - b.imgY;

    const dx = tx - b.groupTx;
    const dy = ty - b.groupTy;
    if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) {
      continue;
    }

    // Sibling images must have moved by the same amount; if not, someone pulled
    // a group apart and we would silently discard that.
    for (const el of els.slice(1)) {
      const sx = el.x / MM_TO_PX - el.customData.bonsai.imgX - el.customData.bonsai.groupTx;
      const sy = el.y / MM_TO_PX - el.customData.bonsai.imgY - el.customData.bonsai.groupTy;
      if (Math.abs(sx - dx) > 0.5 || Math.abs(sy - dy) > 0.5) {
        console.log(
          `  WARN  ${groupKey}: "${el.customData.bonsai.role}" moved independently ` +
            `(${sx.toFixed(1)},${sy.toFixed(1)} vs ${dx.toFixed(1)},${dy.toFixed(1)}) - ` +
            `only the group offset is written`,
        );
      }
    }

    const transform = `translate(${tx.toFixed(6)},${ty.toFixed(6)})`;
    const tagRe = new RegExp(`<g\\b[^>]*\\bid="${groupKey}"[^>]*>`);
    const tag = tagRe.exec(svg);
    if (!tag) {
      console.log(`  WARN  no <g id="${groupKey}"> in layout - skipped`);
      continue;
    }

    const updated = /\btransform\s*=\s*"[^"]*"/.test(tag[0])
      ? tag[0].replace(/\btransform\s*=\s*"[^"]*"/, `transform="${transform}"`)
      : tag[0].replace(/^<g\b/, `<g transform="${transform}"`);

    svg = svg.replace(tag[0], updated);
    moved++;

    const label = b.globalId ? `[${b.globalId}]` : b.kind;
    console.log(
      `  moved  ${groupKey.padEnd(6)} ${label.padEnd(26)} ` +
        `${dx >= 0 ? "+" : ""}${dx.toFixed(2)}, ${dy >= 0 ? "+" : ""}${dy.toFixed(2)} mm`,
    );
  }

  if (moved === 0) {
    console.log("  no drawings moved");
    continue;
  }

  if (!dryRun) {
    writeFileSync(layoutPath, svg, "utf8");
  }
  totalMoved += moved;
  touchedLayouts.add(layoutPath);
}

console.log(
  `\n${dryRun ? "[dry run] would write" : "wrote"} ${totalMoved} moved drawing(s) ` +
    `across ${touchedLayouts.size} layout(s)`,
);
if (totalMoved > 0 && !dryRun) {
  console.log("\nrun bpy.ops.bim.create_sheets() in Blender to rebuild the sheet\n");
}
