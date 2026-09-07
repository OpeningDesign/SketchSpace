# SketchSpace

A self-hosted, password-gated, collaborative **multi-page** whiteboard built on
top of the [`@excalidraw/excalidraw`](https://www.npmjs.com/package/@excalidraw/excalidraw)
React component.

Excalidraw upstream has no pages, and the maintainers have
[deferred the feature](https://github.com/excalidraw/excalidraw/issues/9596#issuecomment-2922623255)
in favour of Excalidraw+ scenes. SketchSpace is not a fork — it consumes the
editor as a package and supplies the two things that package does not ship: a
page model and a collaboration server you own. The editor itself is vendored
from a local excalidraw checkout so your own editor patches come along; see
[Where the editor comes from](#where-the-editor-comes-from).

- **Boards** hold an ordered list of **pages**. One tab strip, one link.
- **Real-time collaboration** on every page, with per-page cursors and
  board-wide presence.
- **Password gate** for the whole instance; past it, all boards are shared.
- **SQLite + a files directory** — one `.db` file and one folder to back up.

## Quick start

The editor is **vendored from a local excalidraw checkout**, not installed from
npm (see [Where the editor comes from](#where-the-editor-comes-from)), so build
it once first:

```bash
cd ../excalidraw && yarn build:packages
cd ../sketchspace && npm install && npm run sync:editor

cp .env.example .env          # then set SKETCHSPACE_PASSWORD
npm run build
npm start
```

Open <http://localhost:3000>.

`npm start` reads `.env` natively (Node's `--env-file-if-exists`), so there is
nothing to export. For a deployment, `docker compose up --build` instead — the
image takes real environment variables and ignores `.env`.

> **Keep the data directory out of Dropbox / OneDrive / iCloud.**
> SQLite in WAL mode keeps `.db`, `.db-shm` and `.db-wal` open together, and a
> file-sync client will both lock them and sync them out of step with each
> other — which risks a corrupt database, not just noise. This repo lives in
> Dropbox, so `.env` points `SKETCHSPACE_DATA_DIR` outside it. The Docker setup
> is unaffected: it uses a named volume.

### Everyday commands

| Command                | What it does                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| `npm start`            | Run the built server, reading `.env`.                             |
| `npm run dev`          | Watch mode. Vite on `:5173` proxying to the server on `:3000` — open **5173**, not 3000. |
| `npm run build`        | Build client then server. Refuses to run if `vendor/` is missing. |
| `npm run typecheck`    | Both tsconfigs. Run after every `sync:editor` — see below.        |
| `npm run sync:editor`  | Re-vendor the editor from your excalidraw checkout.                |
| `npm run smoke`        | End-to-end collaboration suite against a running server.           |

After changing **server** code you must `npm run build` before `npm start`.
After changing **client** code, rebuild and hard-reload the browser
(<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>); no server restart is needed,
since the server only serves static files from `dist/client`.

### Stopping it

`Ctrl+C` if it is in your terminal. Otherwise find it **by port** — the process
command line is a relative path, so filtering on the word "sketchspace" matches
nothing:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Starting a second instance while one is already up prints that same command
along with an `EADDRINUSE` message, rather than a stack trace.

### Verifying collaboration

`scripts/smoke.mjs` drives three concurrent clients against a running server and
checks the whole path — auth, scene deltas, conflict resolution, page isolation,
presence, and persistence. Point it at a **throwaway data directory and port**
so it does not write into your real boards:

```bash
npm run build
SKETCHSPACE_PASSWORD=dev PORT=3111 SKETCHSPACE_DATA_DIR=C:/sketchspace-smoke \
  node dist/server/index.js &
npm run smoke -- http://localhost:3111 dev
```

All 18 checks should report `ok`.

## Configuration

| Variable                    | Required | Default   | Notes                                                        |
| --------------------------- | -------- | --------- | ------------------------------------------------------------ |
| `SKETCHSPACE_PASSWORD`       | yes      | —         | The single shared password. The server refuses to boot without it. |
| `SKETCHSPACE_SESSION_SECRET` | strongly | random    | Signs session cookies. If unset, everyone is logged out on restart. |
| `PORT`                      | no       | `3000`    |                                                              |
| `SKETCHSPACE_DATA_DIR`       | no       | `./data`  | `/data` in the container.                                    |
| `SKETCHSPACE_SECURE_COOKIE`  | no       | `false`   | Set `true` when behind TLS.                                  |

## Where the editor comes from

SketchSpace does **not** depend on `@excalidraw/excalidraw` from npm. It vendors a
build from your own excalidraw checkout into `./vendor`, so any patch you carry
there — a custom preference, a behaviour fix — is actually in this app. The npm
package only ever contains what upstream has released.

```bash
cd ../excalidraw && yarn build:packages   # after any editor change
cd ../sketchspace && npm run sync:editor
```

`scripts/sync-editor.mjs` copies the built `prod` and `types` output of five
packages — `excalidraw`, `common`, `element`, `math`, `fractional-indexing` — and
prints the commit it took them from. Set `EXCALIDRAW_REPO` to use a checkout
somewhere other than `../excalidraw`. `npm run build` refuses to run if the
vendor directory is missing.

Three things are worth knowing about this arrangement:

- **Five packages, not one.** `scripts/buildPackage.js` upstream marks the four
  sibling packages as esbuild externals, so the built editor imports them rather
  than inlining them. (The 0.18.1 npm release *did* inline them, which is why
  depending on the published package needed none of this.) `client/vite.config.ts`
  aliases each sibling — bare and `/*` — onto its single `index.js`, matching what
  each package's own exports map does.
- **The editor's own dependencies are in `devDependencies`.** The upstream build
  runs esbuild with `packages: "external"`, so every bare import — `roughjs`,
  `jotai`, `radix-ui`, `pako`, and ~25 more — has to resolve here. They are
  copied from `packages/excalidraw/package.json` and are needed at build time
  only; the runtime image installs with `--omit=dev`.
- **You are tracking master, not a release.** That is the point, but it cuts both
  ways: upstream can rename things. `excalidrawAPI` became `onExcalidrawAPI` in
  [#10870](https://github.com/excalidraw/excalidraw/pull/10870) after 0.18.1, and
  because the vendored `types` are what tsc reads, `npm run typecheck` catches
  that class of break at build time rather than in the browser.

`vendor/` is gitignored — it is build output. A fresh clone needs an excalidraw
checkout and one `sync:editor` before it can build.

### The menu is composed here, not inherited

`client/src/Board.tsx` passes an explicit `<MainMenu>` to `<Excalidraw>`. This
is **not** cosmetic, and removing it silently costs you features.

When a host app supplies no `<MainMenu>` child, the editor falls back to
`DefaultMainMenu` in `packages/excalidraw/components/LayerUI.tsx` — and that
fallback contains no `<MainMenu.DefaultItems.Preferences />` at all. Everything
inside the Preferences submenu therefore renders nowhere: box-selection mode,
snap mode, grid mode, object snapping, and any preference you add yourself in
your excalidraw checkout. The item is present in the shipped bundle and simply
has no route to the screen.

This is easy to misdiagnose as the vendoring having failed. It has not; grep the
built bundle to confirm the feature is there before suspecting `sync:editor`:

```bash
grep -o wheelBehavior dist/client/assets/index-*.js | head -1
```

excalidraw.com never hits this because `excalidraw-app/components/AppMainMenu.tsx`
supplies its own menu including Preferences. Any embedder relying on the
fallback does hit it.

Scene load/save entries are deliberately omitted from our menu: a page lives on
the server, not in a local file, so "Save to active file" would be misleading.
`ToggleTheme` uses `allowSystemTheme={false}` because system theme requires the
host to own theme state, and SketchSpace does not.

## How it works

### Room topology

Two socket.io rooms per viewer:

```
board:{boardId}    always joined — page list + board-wide presence
page:{pageId}      joined/left on switch — scene updates + cursors
```

Splitting them is what keeps traffic proportional to what you are looking at:
someone editing page 1 never receives a packet of page 7's scene updates, but
still appears in the presence list and still sees pages appear and get renamed.

### The server owns the scene

Unlike excalidraw.com — where collaboration is end-to-end encrypted and the
server is a blind relay — you own this server, so it holds the **authoritative
element map** for every open page. Each incoming batch is reconciled against it
and only the winning elements are rebroadcast as a delta.

The reconciliation rule in [`server/src/reconcile.ts`](server/src/reconcile.ts)
is a deliberate mirror of Excalidraw's own
(`packages/excalidraw/data/reconcile.ts`): higher `version` wins, ties broken by
the **lower** `versionNonce`. Keeping the two in agreement is what lets a late
joiner receive a correct snapshot and two simultaneous editors converge — the
piece a naive rebroadcast server gets wrong.

### Storage

| Table         | Holds                                                    |
| ------------- | -------------------------------------------------------- |
| `boards`      | id, name, timestamps                                     |
| `pages`       | board, name, fractional index, soft-delete flag          |
| `page_scenes` | one JSON element blob per page                           |
| `files`       | image metadata; the data URLs live in `data/files/`       |

Open pages are cached in memory, written back on a 1s debounce, and evicted
five minutes after the last viewer leaves. Everything dirty is flushed on
`SIGTERM`.

### Page ordering

Pages carry a **fractional index** string rather than an integer position, the
same technique Excalidraw uses for element z-order. Inserting between two pages
mints a key strictly between theirs, so two people reordering at once converge
without a coordinator. See [`server/src/fracIndex.ts`](server/src/fracIndex.ts).

### Images

Images are stored per **board**, not per page, so one can be moved between pages
without re-uploading. They are kept as data URLs exactly as the editor produced
them — about 33% larger on disk than raw binary, in exchange for exact
round-tripping.

## Bonsai / IFC integration

SketchSpace can import a [Bonsai](https://bonsaibim.org/) sheet layout as a page,
and write drawing positions back.

```bash
npm run import:layout -- "<project>/Models/Bonsai/layouts/A001 - SITE PLAN.svg"
npm run export:layout -- <boardId> [--dry-run]
# then in Blender:  bpy.ops.bim.create_sheets()
```

**It reads the layout, never the built sheet.** Bonsai keeps two artefacts per
sheet: `layouts/*.svg` is ~3 KB of structure and links; `sheets/*.svg` is the
build output, often several MB of base64 PNG. The layout is the source - drawings
can be regenerated from the model without disturbing the arrangement, and a
change is a readable diff rather than a binary blob.

Each `<g data-type="drawing">` carries `data-drawing`, an **IFC GlobalId**. That
travels into `customData.bonsai.globalId` on the imported element, so a redline
can be anchored to the model rather than to pixels - surviving regeneration,
renaming and re-arrangement.

Three details that are load-bearing:

- **Write-back targets the group `transform`, not image `x`/`y`.** Bonsai's
  `build_drawings` copies each `<g>` into the built sheet with attributes intact,
  swapping only the `<image>` children, so the transform survives the build. It is
  also what Inkscape writes when you drag a group, and it leaves Bonsai's own
  coordinates - and its reflow logic - untouched.
- **The edit is string surgery on one attribute.** Re-serialising the XML would
  reformat the file and destroy the small diff that is the point of layouts.
- **Nested references are inlined on import.** A drawing may reference a raster
  underlay relatively; once the SVG is base64'd into a `data:` URL there is no
  base to resolve that against and the underlay silently vanishes. Bonsai's own
  `sioserver.py` inlines for the same reason.

Sibling images of one layout group (foreground + view-title) are bound into an
Excalidraw group so they move together, and the titleblock imports locked,
honouring Bonsai's `sodipodi:insensitive`.

**Known cost:** inlining a large raster underlay is expensive - one site plan went
from 865 KB to 19 MB. Serving assets over HTTP instead of inlining is the fix, and
needs a raw-bytes file endpoint.

## Deliberate limitations

- **The password is the only boundary.** Anyone who knows it can read, edit, and
  delete every board. That is the intended model for a small trusted group; it
  is not multi-tenant.
- **No end-to-end encryption.** The server reads your drawings — that is the
  trade that makes authoritative reconciliation possible. Do not put this on the
  public internet without TLS in front.
- **No undo across page switches.** Switching pages calls `updateScene` with
  `CaptureUpdateAction.NEVER`, so the switch itself is not an undo step, but
  history is not partitioned per page either.
- **Cross-page element links are not implemented.** Pages are independent
  scenes.
- **No offline mode.** A disconnected client keeps drawing locally but its
  changes are not queued for reconnect.
- **The vendored editor tracks master, not a release.** That is the point, but
  upstream can rename APIs between syncs. `npm run typecheck` is the guard; run
  it after every `sync:editor`.

## Lineage

SketchSpace was first built in 2012 as a real-time whiteboarding plugin for
Etherpad, the core collaboration tool on the OpeningDesign platform. That
codebase is preserved at
[OpeningDesign/SketchSpace_Old_Version](https://github.com/OpeningDesign/SketchSpace_Old_Version).

This is the same idea rebuilt: multi-page, model-aware, version-controlled.

## Licence

MIT — see [LICENSE](LICENSE). The Excalidraw editor it builds on is also MIT.
