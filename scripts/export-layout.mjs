/**
 * Write drawing positions from a board back into its Bonsai layout, from the
 * command line. The in-app "Push to Bonsai" button does the same thing.
 *
 *   npm run export:layout -- <boardId> [--dry-run]
 *   # then in Blender:  bpy.ops.bim.create_sheets()
 *
 * The rules live in server/src/layoutWriter.ts so both paths behave identically.
 */
import { pushBoardToLayouts } from "../dist/server/layoutWriter.js";
import { getBoard } from "../dist/server/db.js";

const boardId = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!boardId) {
  console.error("\nusage: npm run export:layout -- <boardId> [--dry-run]\n");
  process.exit(1);
}
if (!getBoard(boardId)) {
  console.error(`\nno board ${boardId}\n`);
  process.exit(1);
}

const result = pushBoardToLayouts(boardId, !dryRun);

for (const layout of result.layouts) {
  console.log(`\npage "${layout.pageName}"  ->  ${layout.layoutPath}`);
  for (const m of layout.moved) {
    const label = m.globalId ? `[${m.globalId}]` : m.kind;
    const sign = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
    console.log(
      `  moved  ${m.groupKey.padEnd(6)} ${label.padEnd(26)} ${sign(m.dx)}, ${sign(m.dy)} mm`,
    );
    for (const w of m.warnings) {
      console.log(`  WARN   ${w}`);
    }
  }
}

for (const e of result.errors) {
  console.error(`  ERROR  ${e}`);
}

console.log(
  `\n${dryRun ? "[dry run] would write" : "wrote"} ${result.total} moved drawing(s) ` +
    `across ${result.layouts.length} layout(s)`,
);
if (result.total > 0 && !dryRun) {
  console.log("\nrun bpy.ops.bim.create_sheets() in Blender to rebuild the sheet\n");
}
