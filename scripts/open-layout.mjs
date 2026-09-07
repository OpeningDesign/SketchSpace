/**
 * Open a Bonsai layout in SketchSpace, from Blender.
 *
 * Bonsai's `bpy.ops.bim.open_layout()` runs whatever is configured in the
 * `layout_svg_command` preference, substituting the literal token "path" with
 * the layout's file path (see `open_with_user_command` in Bonsai's
 * tool/drawing.py). Point that at this script and the button opens the right
 * sheet in SketchSpace instead of Inkscape.
 *
 * In Bonsai preferences, set Layout SVG Command to (one line, JSON):
 *
 *   [["node", "--env-file-if-exists=D:/Dropbox/GitHub/SketchSpace/.env",
 *     "D:/Dropbox/GitHub/SketchSpace/scripts/open-layout.mjs", "path"]]
 *
 * Bonsai runs this with subprocess.Popen and no shell, so the executable must be
 * resolvable by `shutil.which` - plain "node" is fine - and every argument is a
 * separate list entry. Absolute paths, because the working directory is
 * Blender's, not ours.
 *
 * Three cases, in order:
 *
 *   1. a page already holds this layout        -> open it
 *   2. a board covers this layouts directory   -> add the sheet as a new tab
 *   3. neither                                 -> import the whole sheet set
 *
 * Case 3 imports every sheet in the directory rather than only the one asked
 * for, because a board is an IFC file and its tabs are that file's sheets - a
 * board holding one arbitrary sheet would be a half-built thing. It can take a
 * while on a large set; it happens once per project.
 *
 * Creating boards and pages is safe against a running server: everything written
 * here is new, so nothing the server has cached in memory can overwrite it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { config } from "../dist/server/config.js";
import {
  addSheetToBoard,
  findBoardForLayoutsDir,
  findPageForLayout,
  importSheetSet,
  resolveLayouts,
  sheetName,
} from "../dist/server/layoutImport.js";

const layoutArg = process.argv[2];

if (!layoutArg) {
  console.error("\nusage: node scripts/open-layout.mjs <path to layout.svg>\n");
  process.exit(1);
}
if (!existsSync(layoutArg)) {
  console.error(`\nno such layout: ${layoutArg}\n`);
  process.exit(1);
}

const layoutPath = path.resolve(layoutArg);
const layoutsDir = path.dirname(layoutPath);

let target = findPageForLayout(layoutPath);

if (!target) {
  const board = findBoardForLayoutsDir(layoutsDir);

  if (board) {
    // The set is known but this sheet is new - probably just added in Bonsai.
    const page = addSheetToBoard(board.boardId, layoutPath);
    console.log(`added sheet "${page.name}" to ${board.boardName}`);
    target = {
      boardId: board.boardId,
      pageId: page.id,
      boardName: board.boardName,
      pageName: page.name,
    };
  } else {
    // First time for this project: build the whole board.
    const { files } = resolveLayouts(layoutsDir);
    console.log(`importing ${files.length} sheet(s) from ${layoutsDir}`);

    const { board: newBoard, sheets } = importSheetSet(layoutsDir, files);
    for (const s of sheets) {
      console.log(`  ${s.page.name.padEnd(46)} ${String(s.placements).padStart(3)} placement(s)`);
    }

    const wanted = sheetName(layoutPath);
    const match = sheets.find((s) => s.page.name === wanted) ?? sheets[0];
    console.log(`created board "${newBoard.name}"`);
    target = {
      boardId: newBoard.id,
      pageId: match.page.id,
      boardName: newBoard.name,
      pageName: match.page.name,
    };
  }
}

const url = `http://localhost:${config.port}/#/board/${target.boardId}/${target.pageId}`;
console.log(`opening ${target.boardName} / ${target.pageName}`);
console.log(url);

// Hand off to the platform's browser opener. detached + unref so Blender is not
// left holding a child process.
const opener =
  process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];

spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
