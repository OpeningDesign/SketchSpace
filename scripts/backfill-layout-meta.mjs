/**
 * Backfill Bonsai origin metadata onto a board imported before write-back existed.
 *
 *   npm run backfill:layout -- <boardId> "<path to layout.svg>" [--dry-run]
 *
 * Early imports stored only {kind, role, globalId, stepId, href}. Write-back also
 * needs groupKey / imgX / imgY / groupTx / groupTy / layout, without which
 * export-layout silently finds nothing to do.
 *
 * Matching is by array order: the importer wrote one element per placement in
 * layout order, and neither moving nor editing an element changes that order.
 * The href is checked on every pair as a guard - if it disagrees, we stop rather
 * than write plausible-looking nonsense.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { parseLayout } from "../dist/server/bonsaiLayout.js";
import { config } from "../dist/server/config.js";
import { db } from "../dist/server/db.js";
import { requireServerStopped } from "./lib/require-server-stopped.mjs";

await requireServerStopped(config.port);

const [boardId, layoutPath] = process.argv.slice(2);
const dryRun = process.argv.includes("--dry-run");

if (!boardId || !layoutPath) {
  console.error('\nusage: npm run backfill:layout -- <boardId> "<layout.svg>" [--dry-run]\n');
  process.exit(1);
}
if (!existsSync(layoutPath)) {
  console.error(`\nno such layout: ${layoutPath}\n`);
  process.exit(1);
}

const board = db.prepare("SELECT id, name FROM boards WHERE id = ?").get(boardId);
if (!board) {
  console.error(`\nno board ${boardId}\n`);
  process.exit(1);
}

const layout = parseLayout(layoutPath);
const pages = db
  .prepare("SELECT id, name FROM pages WHERE board_id = ? AND deleted = 0 ORDER BY frac_index")
  .all(board.id);

let patched = 0;

for (const page of pages) {
  const row = db.prepare("SELECT elements FROM page_scenes WHERE page_id = ?").get(page.id);
  if (!row) {
    continue;
  }
  const elements = JSON.parse(row.elements);
  const bonsai = elements.filter((e) => e.customData?.bonsai);

  if (bonsai.length === 0) {
    continue;
  }
  if (bonsai.length !== layout.placements.length) {
    console.error(
      `\npage "${page.name}": ${bonsai.length} imported elements but the layout has ` +
        `${layout.placements.length} placements - refusing to guess.\n`,
    );
    process.exit(1);
  }

  for (let i = 0; i < bonsai.length; i++) {
    const el = bonsai[i];
    const p = layout.placements[i];
    const existing = path.basename(String(el.customData.bonsai.href ?? ""));
    const incoming = path.basename(p.href);
    if (existing && existing !== incoming) {
      console.error(
        `\nmismatch at index ${i}: element has "${existing}", layout has "${incoming}" ` +
          `- order assumption is wrong, aborting.\n`,
      );
      process.exit(1);
    }

    el.customData.bonsai = {
      ...el.customData.bonsai,
      groupKey: p.groupKey,
      imgX: p.imgX,
      imgY: p.imgY,
      groupTx: p.groupTx,
      groupTy: p.groupTy,
      layout: layoutPath,
    };
    // Bind siblings so they move together from here on.
    el.groupIds = [`bonsai:${p.groupKey}`];
    patched++;
  }

  if (!dryRun) {
    db.prepare("UPDATE page_scenes SET elements = ?, updated_at = ? WHERE page_id = ?").run(
      JSON.stringify(elements),
      Date.now(),
      page.id,
    );
  }
  console.log(`page "${page.name}": patched ${bonsai.length} imported elements`);
}

console.log(
  `\n${dryRun ? "[dry run] would patch" : "patched"} ${patched} element(s) on "${board.name}"\n`,
);
