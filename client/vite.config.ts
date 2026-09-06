import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite resolves a relative `root` against the config file's own directory,
// which makes "client" mean "client/client". Anchor it explicitly instead.
const here = dirname(fileURLToPath(import.meta.url));
const vendor = (pkg: string) =>
  resolve(here, `../vendor/${pkg}/prod/index.js`);

/**
 * The editor and its four sibling packages resolve to the locally built copies
 * in ./vendor, never to node_modules - that is what puts patches carried in the
 * excalidraw checkout into this app. Refresh them with `npm run sync:editor`.
 *
 * Each sibling is aliased twice: bare, and with a `/*` catch-all. The editor
 * bundle imports subpaths like `@excalidraw/element/binding`, and every
 * sibling's exports map collapses `./*` onto its single index.js at runtime,
 * so pointing the whole subtree at index.js is what the package itself does.
 */
const editorAliases = [
  { find: /^@excalidraw\/excalidraw$/, replacement: vendor("excalidraw") },
  ...["common", "element", "math", "fractional-indexing"].flatMap((pkg) => [
    { find: new RegExp(`^@excalidraw/${pkg}$`), replacement: vendor(pkg) },
    { find: new RegExp(`^@excalidraw/${pkg}/.*$`), replacement: vendor(pkg) },
  ]),
];

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: { alias: editorAliases },
  define: {
    // Excalidraw's bundle reads this at runtime; without it the app throws on boot.
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  build: {
    outDir: resolve(here, "../dist/client"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/socket.io": { target: "http://localhost:3000", ws: true },
    },
  },
});
