/**
 * Import a Bonsai project as a SketchSpace board: one board per IFC file, one
 * page (tab) per sheet.
 *
 *   npm run import:sheets -- "<project>/Models/Bonsai"            # whole set
 *   npm run import:sheets -- "<project>/Models/Bonsai/layouts"    # same thing
 *   npm run import:sheets -- "<...>/layouts/A001 - SITE PLAN.svg" # one sheet
 *   npm run import:sheets -- <path> --board <boardId>             # add to a board
 *   npm run import:sheets -- <path> --name "Barn 2.0"
 *
 * Blender's "open layout" button does this on demand via
 * scripts/open-layout.mjs; both share server/src/layoutImport.ts.
 */
import { existsSync } from "node:fs";

import { config } from "../dist/server/config.js";
import { getBoard } from "../dist/server/db.js";
import {
  addSheetToBoard,
  importSheetSet,
  resolveLayouts,
} from "../dist/server/layoutImport.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const target = args.find(
  (a, i) => !a.startsWith("--") && args[i - 1] !== "--board" && args[i - 1] !== "--name",
);
const existingBoardId = flag("--board");
const nameOverride = flag("--name");

if (!target || !existsSync(target)) {
  console.error(
    "\nusage: npm run import:sheets -- <bonsai dir | layouts dir | layout.svg>" +
      " [--board <boardId>] [--name <board name>]\n",
  );
  process.exit(1);
}

const { dir: layoutsDir, files } = resolveLayouts(target);
if (files.length === 0) {
  console.error(`\nno .svg sheets in ${layoutsDir}\n`);
  process.exit(1);
}

let board;
let total = 0;

if (existingBoardId) {
  board = getBoard(existingBoardId);
  if (!board) {
    console.error(`\nno board ${existingBoardId}\n`);
    process.exit(1);
  }
  console.log(`\nboard  : ${board.name} (${board.id})`);
  console.log(`sheets : ${files.length} from ${layoutsDir}\n`);

  for (const file of files) {
    const page = addSheetToBoard(board.id, file);
    console.log(`  ${page.name}`);
    total++;
  }
} else {
  const result = importSheetSet(layoutsDir, files, nameOverride ?? undefined);
  board = result.board;
  console.log(`\nboard  : ${board.name} (${board.id})`);
  console.log(`sheets : ${files.length} from ${layoutsDir}\n`);
  for (const s of result.sheets) {
    console.log(
      `  ${s.page.name.padEnd(46)} ${String(s.placements).padStart(3)} placement(s)`,
    );
    total += s.placements;
  }
}

console.log(`\nimported ${files.length} sheet(s), ${total} placement(s)`);
console.log(`open     http://localhost:${config.port}/#/board/${board.id}\n`);
