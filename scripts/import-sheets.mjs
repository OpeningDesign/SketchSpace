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
 * A drawing set is a board and each sheet is a tab, which is the whole point of
 * the page model. Placement import goes through syncPageWithLayout - the same
 * code the layout watcher uses - so a fresh page and a re-synced one are built
 * by one implementation.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { config } from "../dist/server/config.js";
import { createBoard, createPage, getBoard, saveSceneJSON } from "../dist/server/db.js";
import { syncPageWithLayout } from "../dist/server/layoutSync.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const target = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--board" && args[args.indexOf(a) - 1] !== "--name");
const existingBoardId = flag("--board");
const nameOverride = flag("--name");

if (!target || !existsSync(target)) {
  console.error(
    "\nusage: npm run import:sheets -- <bonsai dir | layouts dir | layout.svg>" +
      " [--board <boardId>] [--name <board name>]\n",
  );
  process.exit(1);
}

/** Resolve whatever was passed into a layouts directory plus its sheet files. */
const resolveLayouts = (input) => {
  if (statSync(input).isFile()) {
    return { dir: path.dirname(input), files: [input] };
  }
  const dir = existsSync(path.join(input, "layouts"))
    ? path.join(input, "layouts")
    : input;
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".svg"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => path.join(dir, f));
  return { dir, files };
};

const { dir: layoutsDir, files } = resolveLayouts(path.resolve(target));

if (files.length === 0) {
  console.error(`\nno .svg sheets in ${layoutsDir}\n`);
  process.exit(1);
}

/**
 * Board identity comes from the IFC file that sits beside layouts/ - Bonsai
 * resolves every drawing path relative to the IFC file's directory, so that is
 * the natural unit. Prefer one whose name appears in the path when a project
 * holds several.
 */
const deriveBoardName = () => {
  if (nameOverride) {
    return nameOverride;
  }
  const projectDir = path.dirname(layoutsDir);
  const ifcs = existsSync(projectDir)
    ? readdirSync(projectDir).filter((f) => f.toLowerCase().endsWith(".ifc"))
    : [];
  if (ifcs.length > 0) {
    const normalised = projectDir.replace(/\\/g, "/").toLowerCase();
    const preferred =
      ifcs.find((f) => normalised.includes(path.basename(f, ".ifc").toLowerCase())) ??
      ifcs.sort()[0];
    return path.basename(preferred, ".ifc");
  }
  return path.basename(projectDir);
};

const sheetName = (file) => path.basename(file, path.extname(file));

let board;
let firstPage = null;

if (existingBoardId) {
  board = getBoard(existingBoardId);
  if (!board) {
    console.error(`\nno board ${existingBoardId}\n`);
    process.exit(1);
  }
} else {
  const created = createBoard(deriveBoardName());
  board = created.board;
  firstPage = created.page;
}

console.log(`\nboard  : ${board.name} (${board.id})`);
console.log(`sheets : ${files.length} from ${layoutsDir}\n`);

let totalPlacements = 0;

for (const [i, file] of files.entries()) {
  const name = sheetName(file);

  // createBoard already made a page; reuse it for the first sheet rather than
  // leaving an empty "Page 1" behind.
  let page;
  if (firstPage && i === 0) {
    page = firstPage;
    // Rename the default page to the sheet it now holds.
    const { renamePage } = await import("../dist/server/db.js");
    renamePage(page.id, name);
  } else {
    page = createPage(board.id, name, null);
  }

  const summary = syncPageWithLayout([], board.id, file);
  saveSceneJSON(page.id, JSON.stringify(summary.changed));
  totalPlacements += summary.added;

  console.log(`  ${name.padEnd(46)} ${String(summary.added).padStart(3)} placement(s)`);
}

console.log(`\nimported ${files.length} sheet(s), ${totalPlacements} placement(s)`);
console.log(`open     http://localhost:${config.port}/#/board/${board.id}\n`);
