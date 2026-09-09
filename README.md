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

See [NOTES.md](NOTES.md) for lessons learned and the roadmap.

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
cd ../excalidraw && git switch SketchSpace && yarn build:packages
cd ../SketchSpace && npm install && npm run sync:editor

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

## Sharing a view

The address bar always points at what is on screen:

```
#/board/<boardId>/<pageId>?v=<x1>,<y1>,<x2>,<y2>
```

Pan or zoom and it rewrites itself (via `replaceState`, throttled, so the back
button stays useful). Copy the URL and you have shared the sheet *and the region*
- "look at this detail on A501" becomes a link rather than a description, which
matters on a construction sheet where most of the page is not the thing you mean.

Opening such a link frames that region with `fit: "contain"`. Only the box is
encoded, not a zoom level, so a link resolves to the same *content* on a laptop
and a 4K monitor rather than reproducing someone else's pixel zoom.

The idea is lifted from [first-draft's URL view sharing](https://gitlab.com/MeldCE/first-draft/-/merge_requests/69),
which encodes the viewport as `l/t/r/b/z` query parameters. Excalidraw's
`getVisibleSceneBounds` and `setViewport({ target })` speak scene-coordinate
boxes directly, so no coordinate maths of our own is involved.

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
cd ../excalidraw
git switch SketchSpace                    # our long-lived editor branch
yarn build:packages                       # after any editor change
cd ../SketchSpace && npm run sync:editor
```

Editor work lives on the **`SketchSpace` branch** of
[OpeningDesign/excalidraw](https://github.com/OpeningDesign/excalidraw), a fork of
upstream and that fork's default branch. `master` there stays a pristine mirror of
`excalidraw/excalidraw`, so `git log master..SketchSpace` answers "what is ours?"
exactly. To take upstream changes: `git fetch upstream && git merge upstream/master`
on `SketchSpace`, then re-run `sync:editor` and `npm run typecheck`.

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

**One board per IFC file, one tab per sheet.** A drawing set is a board; each
sheet is a page. Once a project is imported the two stay in step automatically,
in both directions.

### From Blender

Set Bonsai's **Layout SVG Command** preference to (one line, JSON):

```json
[["node", "--env-file-if-exists=D:/path/to/SketchSpace/.env", "D:/path/to/SketchSpace/scripts/open-layout.mjs", "path"]]
```

`bpy.ops.bim.open_layout()` then opens the sheet in SketchSpace instead of
Inkscape. Bonsai runs this through `subprocess.Popen` with no shell, so the
executable must be resolvable by `shutil.which`, every argument is a separate
list entry, and the literal token `"path"` is replaced with the layout's path.

The script handles three cases: the sheet is already a tab (opens it), the board
exists but this sheet is new (adds a tab), or neither (imports the whole set and
creates the board). First use on a project imports every sheet, which can take a
minute; it happens once.

### Or from the command line

```bash
npm run import:sheets -- "<project>/Models/Bonsai"           # the whole set
npm run import:sheets -- "<...>/layouts/A001 - SITE PLAN.svg"  # a single sheet
npm run import:sheets -- <path> --board <boardId>            # add tabs to a board
```

The board takes its name from the `.ifc` file beside `layouts/`, since Bonsai
resolves every drawing path relative to that file's directory.

### What stays in sync

- **Move a drawing here** and the layout SVG is rewritten about two seconds after
  it settles. A pill bottom-right reads `layout saved`. Run
  `bpy.ops.bim.create_sheets()` in Blender to rebuild the sheet.
- **Add a sheet in Bonsai** and a tab appears.
- **Rename a sheet** and the tab follows it, rather than duplicating.
- **Delete a sheet** and the tab goes — unless you have drawn on it.
- **Add, remove or regenerate a drawing** and the sheet updates in place,
  including Bonsai's reflow of its neighbours.
- **Edit a linked file** — a titleblock, a view-title asset, a drawing redrawn
  without changing size — and every sheet placing it refreshes.

The directories watched for that last one are **derived from the layouts
themselves**, not hardcoded and not read from the IFC: each `<image href>` is
resolved against its layout's directory and the containing directory is watched.
So `schedules/` is watched only on projects that place one, and a reference
living in another repo via a git submodule is followed just the same.

Redlines are never written to the layout; they carry no `customData.bonsai`.

### Sheet identity is content, not filename

A layout SVG records no identity of its own — its root `<svg>` carries only
`id="root"` — and Bonsai renames the file when a sheet is renamed. Matching on
path alone therefore reads a rename as a brand new sheet: the old tab is orphaned
and a duplicate appears.

A sheet is instead identified by the **set of IFC GlobalIds** of the drawings it
places (`data-drawing`), which survives renaming. That is what lets a rename
rebind the existing tab.

Tab names still come from filenames, so a sheet called `A01 - PLANS, SECTIONS`
appears as `A01 - PLANS SECTIONS` — Bonsai strips commas when writing the file.

### When a tab is removed automatically

Only when its layout file is gone **and** nothing you drew is on it. A tab
carrying redlines is kept and reported instead, because redlines exist nowhere
else. Deletion is a soft delete, so a wrong call is recoverable from the database.

If a layouts directory suddenly contains no layouts at all, nothing is touched —
a disconnected drive or a sync hiccup looks identical to a mass deletion and is
far more likely.

### Details that are load-bearing

- **Write-back targets the group `transform`, not image `x`/`y`.** Bonsai's
  `build_drawings` copies each `<g>` into the built sheet with attributes intact,
  swapping only the `<image>` children, so the transform survives the build. It is
  what Inkscape writes when you drag a group, and it leaves Bonsai's own
  coordinates and reflow logic untouched.
- **The edit is string surgery on one attribute.** Re-serialising the XML would
  reformat the file and destroy the small diff that is the point of layouts.
- **Writes refresh the stored baseline.** Our own writes are echo-suppressed by
  content hash so the watcher ignores them, which means nothing else would
  refresh `groupTx`; without it every change rewrites the whole sheet.
- **Nested references are inlined on import.** A drawing may reference a raster
  underlay relatively, and once the SVG is base64'd into a `data:` URL there is no
  base to resolve it against.
- **SVG attributes are read by local name.** Inkscape rewrites namespace prefixes
  inconsistently; matching `xlink:href` literally made a sheet that binds the
  namespace as `ns3` parse to zero placements, silently.

Sibling images of one layout group (foreground + view-title) are bound into an
Excalidraw group so they move together, and the titleblock imports locked,
honouring Bonsai's `sodipodi:insensitive`.

**Moving a placement edits your project repository within ~2 seconds.** `git diff`
reviews a session; `git checkout --` undoes it.

### Assets

Assets are stored as **raw bytes** and served from
`GET /api/boards/:id/assets/:fileId`, not embedded as `data:` URLs in JSON.
Excalidraw loads images with `image.src = dataURL` on a plain `new Image()`, so a
same-origin URL works - and being same-origin keeps the canvas untainted, so PNG
and SVG export still work. Ids are content hashes, so responses are served
`immutable`: a title block shared by fourteen sheets is fetched once.

On a real set this is the difference between a 26 MB JSON response per sheet and
a 1.7 KB one.

**What it does not fix:** a raster underlay referenced *inside* a drawing SVG must
still be inlined as a data URL. An SVG loaded through `<img>` runs in secure
static mode and cannot fetch external resources at all, so an HTTP reference
there renders nothing - the same wall a relative reference hits. One site plan is
19.7 MB for this reason. It is now fetched once and cached rather than re-sent,
but the bytes are still there. Gzipping the asset endpoint and downsampling
underlays at import are the remaining levers.

### Repair and scripting

`npm run export:layout -- <boardId> [--dry-run]` writes positions from the command
line, and `npm run backfill:layout` repairs boards imported before write-back
metadata existed. Both **refuse to run while the server is up** (except
`--dry-run`, which is read-only): the server caches open pages in memory and would
overwrite a direct database edit on its next flush.

## Backups

Two halves, with very different value:

| | size | replaceable? |
| --- | --- | --- |
| `sketchspace.db` | ~0.5 MB | **No.** Redlines, sheet arrangement, which layout maps to which tab |
| `files/` | hundreds of MB | Yes — re-importable from Bonsai |

Redlines exist nowhere else. The assets are derived from drawings that live in
your own repositories.

```bash
npm run backup                                    # to the default location
npm run backup -- --out D:/Dropbox/SS-Backups     # anywhere you like
npm run backup -- --timestamped --keep 14         # if you have no versioning
npm run backup -- --assets                        # mirror the assets too
npm run backup -- --assets E:/SS-Assets           # ...or somewhere else
```

`SKETCHSPACE_BACKUP_DIR` works too.

**The script knows nothing about Dropbox, restic, borg or anything else.** Its
only job is to produce a consistent `.db` at a path you choose; whatever backs
that path up is your business. Point `--out` at a synced folder and you are done.

It runs against the **live server** — no downtime. `VACUUM INTO` produces one
self-contained, compacted file, written under a `.partial` name and renamed into
place so a backup tool never catches a half-written snapshot. Every run verifies
the result with `integrity_check` and a row count before reporting success.

Defaults chosen to suit whatever is downstream: **one stable filename** (Dropbox
versions a path, restic and borg deduplicate against the previous blob, rsync
sends deltas — timestamps defeat all three), **no compression** (compresses
badly against dedupe; your backup tool does it better), and **no retention**
unless asked (restic `forget`, borg `prune` and Dropbox versions all do it
properly).

`files/` is skipped unless `--assets` is given. It is content-addressed and
written once, so it is safe to mirror live with any tool — but doing it here gets
the **ordering** right, which matters more than it looks.

The snapshot is taken first and the assets mirrored after. Everything the
snapshot references was written before it was taken, so a mirror run afterwards
necessarily contains all of it; a few extra assets copied in between are
harmless. The reverse order is not safe — an asset written between the mirror and
the snapshot would be referenced but missing, and the restore shows a broken
image.

The copy never deletes. A filename is a hash of its contents, so a name that
already exists is already correct and is skipped, and an asset that an older
snapshot still references is never removed just because the current database has
stopped using it. First run copies everything; later runs copy only what is new.

### Restoring

```bash
# 1. stop the server
# 2. put the snapshot and the assets in one directory
cp sketchspace-2026-09-09.db  <restore-dir>/sketchspace.db
cp -r <old data dir>/files    <restore-dir>/files
# 3. point the server at it
SKETCHSPACE_DATA_DIR=<restore-dir> npm start
```

This procedure is exercised, not assumed: a server booted from a snapshot
recovers every board and tab, and assets serve normally. Restore the `.db`
without `files/` and the boards return with broken images — re-importing
regenerates the assets but creates *new* boards, so redlines would not reattach.

### Nightly

Windows Task Scheduler, running `npm run backup` daily with the working
directory set to this repo. Missed runs (machine asleep) are caught up on the
next login.

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
