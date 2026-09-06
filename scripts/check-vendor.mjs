/** Fails the build early, with a useful message, if the editor was never vendored. */
import { existsSync } from "node:fs";

if (!existsSync("vendor/excalidraw/prod/index.js")) {
  console.error(
    "\n  vendor/excalidraw is missing.\n" +
      "  Build the editor, then vendor it:\n\n" +
      "    cd ../excalidraw && yarn build:packages\n" +
      "    cd ../sketchspace && npm run sync:editor\n",
  );
  process.exit(1);
}
