/**
 * Vendors a locally built Excalidraw editor into ./vendor/excalidraw.
 *
 * SketchSpace deliberately does NOT depend on @excalidraw/excalidraw from npm.
 * The npm build only contains what upstream has released, so any patch you
 * carry in your own excalidraw checkout (a custom preference, a behaviour fix)
 * would silently not exist here.
 *
 * Instead: build the package in your excalidraw checkout, then run this to copy
 * the result in.
 *
 *   cd ../excalidraw && yarn build:packages
 *   cd ../sketchspace && npm run sync:editor
 *
 * Point at a checkout elsewhere with EXCALIDRAW_REPO=/path/to/excalidraw.
 *
 * The copy is vendored rather than aliased to an absolute path on purpose: the
 * Docker build context is this directory, so an alias pointing outside it would
 * build fine locally and break in the container.
 */
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

const repo = path.resolve(
  projectRoot,
  process.env.EXCALIDRAW_REPO ?? "../excalidraw",
);
/**
 * scripts/buildPackage.js marks these four as esbuild externals, so the built
 * editor imports them rather than inlining them. (The 0.18.1 npm release
 * inlined them, which is why depending on the published package needed none of
 * this.) Each sibling's exports map collapses every subpath onto its single
 * index.js, so one alias per package is enough - see client/vite.config.ts.
 */
const PACKAGES = [
  "excalidraw",
  "common",
  "element",
  "math",
  "fractional-indexing",
];

const target = path.join(projectRoot, "vendor");

const die = (message) => {
  console.error(`\n[sync-editor] ${message}\n`);
  process.exit(1);
};

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(repo))) {
  die(
    `No excalidraw checkout at ${repo}.\n` +
      `Set EXCALIDRAW_REPO to point at one.`,
  );
}

for (const pkg of PACKAGES) {
  const dist = path.join(repo, "packages", pkg, "dist");
  if (!(await exists(path.join(dist, "prod", "index.js")))) {
    die(
      `packages/${pkg}/dist/prod/index.js is missing.\n` +
        `Build them first:  cd ${repo} && yarn build:packages`,
    );
  }
}

if (!(await exists(path.join(repo, "packages/excalidraw/dist/prod/index.css")))) {
  die(`The editor build has no index.css - re-run yarn build:packages.`);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const pkg of PACKAGES) {
  const dist = path.join(repo, "packages", pkg, "dist");
  // Only `prod` (what we ship) and `types` (what tsc reads). The `dev` build is
  // an unminified duplicate that nothing here imports, and it is over half the
  // size of the dist.
  for (const part of ["prod", "types"]) {
    if (await exists(path.join(dist, part))) {
      await cp(path.join(dist, part), path.join(target, pkg, part), {
        recursive: true,
      });
    }
  }
}

// Record which commit the vendored build came from, so it is obvious when the
// editor here has drifted from the checkout.
let provenance = "unknown";
try {
  const head = await readFile(path.join(repo, ".git", "HEAD"), "utf8");
  const ref = head.trim().replace(/^ref:\s*/, "");
  provenance = head.startsWith("ref:")
    ? (await readFile(path.join(repo, ".git", ref), "utf8")).trim().slice(0, 12)
    : ref.slice(0, 12);
} catch {
  // Not a git checkout, or a worktree with a non-standard layout.
}

console.log(`[sync-editor] vendored from ${repo}`);
console.log(`[sync-editor] excalidraw commit: ${provenance}`);
console.log(`[sync-editor] packages: ${PACKAGES.join(", ")}`);
console.log(`[sync-editor] -> ${path.relative(projectRoot, target)}`);
