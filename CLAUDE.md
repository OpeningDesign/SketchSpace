# CLAUDE.md

Self-hosted collaborative multi-page whiteboard. React + Vite client wrapping
the Excalidraw editor; Express + socket.io + SQLite server. Read `README.md`
first — it covers the architecture. This file covers what bites you.

`NOTES.md` is the longer record: lessons learned (mostly silent failures, each
with symptom and cause) and the roadmap. Add to it when something costs an hour.

## The editor is vendored, not an npm dependency

`@excalidraw/excalidraw` is **deliberately absent from `package.json`**. The
editor is built in a sibling excalidraw checkout and copied into `vendor/` by
`scripts/sync-editor.mjs`, so patches carried in that checkout are in this app.

**Do not "fix" a missing-module error by installing `@excalidraw/excalidraw`.**
That yields two editors in the tree and no clear answer as to which is live.
The correct fix is almost always:

```bash
cd ../excalidraw && git switch SketchSpace && yarn build:packages
cd ../SketchSpace && npm run sync:editor && npm run typecheck
```

Editor changes belong on the **`SketchSpace` branch** of OpeningDesign/excalidraw
(the fork's default). Never commit to `master` there - it mirrors upstream, which
is what keeps `git log master..SketchSpace` meaning "our patches". `upstream` has
its push URL disabled on purpose.

Five packages are vendored (`excalidraw`, `common`, `element`, `math`,
`fractional-indexing`) because upstream's `buildPackage.js` marks the four
siblings as esbuild externals. `client/vite.config.ts` aliases each — bare and
`/*` — onto its single `index.js`. The ~31 third-party entries in
`devDependencies` exist because that build runs `packages: "external"`; they are
the editor's own runtime imports, not ours. Don't prune them.

## Traps

**Tracking master means upstream renames reach you.** `excalidrawAPI` became
`onExcalidrawAPI` in excalidraw#10870 after the 0.18.1 release. Because
`client/tsconfig.json` points at the *vendored* types, `npm run typecheck`
catches this class of break. Always typecheck after `sync:editor`.

**A missing editor feature is usually menu composition, not vendoring.** The
editor's fallback menu omits `Preferences` entirely, so anything inside it
renders nowhere unless `Board.tsx` lists it in our `<MainMenu>`. Confirm the
feature is in the bundle (`grep -o <feature> dist/client/assets/index-*.js`)
before suspecting the vendoring.

**Never put the data directory in Dropbox.** SQLite WAL keeps three files open
in lockstep; a sync client locks them and syncs them out of step. This repo is
inside Dropbox, so `SKETCHSPACE_DATA_DIR` points outside it. Symptom: "Device or
resource busy" on the `.db` files.

**Find the server process by port, not by name.** It runs as
`node dist/server/index.js` — a relative path — so filtering process command
lines for "sketchspace" matches nothing and reports "not running" while it is
plainly serving.

**Backups: `VACUUM INTO`, never the backup API.** The backup API copies the
source's WAL mode, so the snapshot grows its own `-shm`/`-wal` as soon as
anything opens it — three files again, and orphans when an old snapshot is
pruned. `VACUUM INTO` writes a plain `journal_mode=delete` file. See
`scripts/backup.mjs`.

**`npm install` here is slow** (Dropbox + a better-sqlite3 native build). Run it
in the background and expect minutes, not seconds.

## Where things live

| Concern                           | File                              |
| --------------------------------- | --------------------------------- |
| Reconciliation (mirrors upstream) | `server/src/reconcile.ts`         |
| Authoritative scene state, caching, debounced persistence | `server/src/store.ts` |
| Socket rooms, presence, page ops  | `server/src/collab.ts`            |
| Schema and queries                | `server/src/db.ts`                |
| Page ordering                     | `server/src/fracIndex.ts`         |
| HTTP routes, auth, static, files  | `server/src/index.ts`             |
| Client collab wiring              | `client/src/useCollab.ts`         |
| Editor mount + menu composition   | `client/src/Board.tsx`            |
| Model values for templates        | `server/src/ifcValues.ts` + `server/python/ifc_values.py` |
| Live values from Bonsai           | `server/src/bonsaiBridge.ts` (Bonsai side: `sheets` handler, *Keep Web Connection* preference) |
| Filling view-titles / titleblocks | `server/src/templates.ts`         |

`server/src/reconcile.ts` intentionally mirrors
`packages/excalidraw/data/reconcile.ts` upstream: higher `version` wins, ties
broken by the **lower** `versionNonce`. If you change one, check the other —
divergence produces clients that disagree with the server and is not something
the smoke test will obviously catch.

## Bonsai integration

`bonsaiLayout.ts` parses layouts, `layoutSync.ts` reconciles a page against one,
`layoutImport.ts` creates boards and tabs, `layoutWatcher.ts` watches for
Bonsai's edits, `layoutWriter.ts` writes ours back on a debounce. The README
explains the model. What will bite:

- **Read layouts, never `sheets/*.svg`.** The built sheet is megabytes of base64
  PNG, regenerated by `create_sheets()`; anchoring to it is pointless.
- **Move a drawing with its group `transform`; move a view-title with the
  title's own `x`/`y`.** Verified against `build_drawings` in Bonsai's
  `sheeter.py`, which preserves `<g>` attributes through the build and renders
  each image at its own `x`/`y` inside the group. Never move a *drawing* through
  its foreground's `x`/`y` - that is Bonsai's, re-centred on every resize.
  Changing this silently breaks the round trip.
- **Anchor a group on its drawing, never on its title.** The writer derives the
  group transform from one element; if that were the title, moving only the
  title would drag the whole drawing. Array order is not a safe way to choose.
- **Nothing the writer declines to save may vanish silently.** Autosave has no
  UI, so its warnings go to the log.
- **Never re-serialise the layout XML.** String-replace the single attribute.
- **A write must refresh `groupTx`/`groupTy` on the elements.** Our writes are
  echo-suppressed by content hash, so the watcher will not do it. Skip this and
  every change rewrites every placement, forever.
- **A sheet is identified by its drawing GlobalId set, not its filename.** Bonsai
  renames the layout file when a sheet is renamed; path matching reads that as a
  new sheet and duplicates the tab. See `drawingGuidSet` / `findRenamedPage`.
  The set must be the drawings the page places *now* - live from the store,
  deleted placements left out. Failing an exact match, the sheet number plus a
  shared drawing (or no drawings on either side) identifies it, if unambiguous.
- **In `reconcileDirectory`, match every rename before removing anything,** and
  never remove a page rebound in the same pass: its old layout path is gone by
  definition. Its last step removes empty duplicate tabs on one layout.
- **While the server runs, it is the one writer for a board it watches.**
  `open-layout.mjs` waits for it to bind a layout rather than adding a sheet to
  an existing board itself - racing it made two tabs for one sheet.
- **Watch the directory, not only the files.** Additions and renames never reach
  a watcher bound to a path that no longer exists.
- **`fs.watch` is not recursive.** A watch on `layouts/` cannot see
  `layouts/titleblocks/`, so linked assets need their own watchers - derived from
  each layout's resolved hrefs, never hardcoded. And a linked-file change must
  bypass the layout content-hash guard, since the layout itself did not change
  (`resyncLayoutAssets`).
- **`boundPages()` reads the database, which lags the store.** Resolve a page's
  live layout path through `getElements` before comparing, or a rebind looks
  un-done and is applied again on every pass.
- Position is `<g transform>` *composed with* `<image x/y>`. Bonsai writes the
  latter, Inkscape the former; both count.
- Layout hrefs carry **two** encodings and `resolveHref` takes both off, XML
  first: character references (`W4A&#216;F` for `W4AØF`) then URL escaping with
  backslashes (`..%5Cdrawings%5C...`). Reading only one leaves a path no file has.
- **Read SVG attributes by local name, never by prefix.** Inkscape rewrites
  namespace prefixes on save and not consistently - one sheet has `xlink:href`,
  another binds the same namespace as `ns3` and writes `ns3:href`. Matching the
  prefix made a whole sheet parse to zero placements with no error.
- **Assets are raw bytes served over HTTP**, not data URLs in JSON (see
  `server/src/assets.ts`). But nested raster references inside a drawing SVG must
  stay inlined: SVG-in-`<img>` is secure static mode and fetches nothing.

**Deleting a tab is the one destructive thing here.** It happens only when the
layout file is gone *and* the page holds nothing the user drew, and never when a
directory has no layouts at all. Keep both guards.

**`scripts/lib/server-control.mjs` owns "is the server up?"** - both the
autostart in `open-layout.mjs` and the guard in `require-server-stopped.mjs` use
it. Two implementations of that question is exactly the drift that bit write-back.

**Never write page_scenes directly while the server runs.** It caches open pages
and overwrites on flush - the edit appears to work, then vanishes. Use
`scripts/lib/require-server-stopped.mjs`, as the export and backfill scripts do.
Creating *new* boards and pages is safe, which is why import does not need it.

### Template values

View-titles and titleblocks are filled from the model; see README, "Titles and
titleblocks". What bites:

- **Match Bonsai's output, quirks included.** `ifc_values.py` mirrors
  `sheeter.py` (`build_drawings`, `build_documents`, `build_titleblock`,
  `_get_git_revisions`) and converts values with `str()` as pystache does, so an
  unset attribute is the word `None` - on the built sheet too. Do not "fix" it
  here alone. Verify changes against a built `sheets/*.svg`.
- **Escape like Python's `html.escape`, not mustache.js's default,** which also
  escapes `/` and would change every imperial scale.
- **Match a view-title to its reference by file, never `data-id`.** STEP ids do
  not survive a merge (IfcOpenShell#9468). A drawing falls back to its GlobalId,
  for when the layout and the saved model disagree on the file - an unsaved
  rename in Blender moves the SVG and relinks the layout immediately.
- **The edit panel holds its own anchor, not the editor's selection.** A locked
  element (the titleblock) is never selected - only `activeLockedId` - and a save
  replaces the scene, which drops that. It follows `groupKey`, and re-anchors to
  the layout path Bonsai answers with, since renaming a sheet moves its layout.
- **A deleted placement goes to Bonsai, not to the layout.** The layout is what
  places the drawing, so a delete that does not reach Bonsai is undone by the
  next sync. `scheduleSheetRemovals` asks the layout which groups have no living
  element left, which makes it idempotent - once removed, there is nothing left
  to ask about.
- **Reopening a model rolls back the model, never the layout files.** So the two
  are reconciled both ways on open (`restore_all_moved_files`): extra groups out,
  missing groups back. Never assume the model is the only thing that can be
  ahead.
- **A drawing's asset is cached against every file it was built from**
  (`linkedAssets.ts`): the drawing and each image inlined into it, keyed on mtime
  and size. Keying on the drawing alone misses a redrawn underlay. Rendered
  view-titles are never cached - they depend on model values too.
- **Nothing on the startup path may read a whole file to look at its head.**
  `migrateDataUrlAssets` did, over 1821 MB, before `listen`. It now reads five
  bytes and records completion in `<dataDir>/.assets-migrated`.
- **Drawing sizes come from `drawingSizeMm`, not `intrinsicSizeMm`.** The first
  caches against mtime+size in `<dataDir>/drawing-sizes.json`; the second opens
  the file, which costs ~135ms cold on a Dropbox path against ~0.8ms on NTFS. Any
  new caller wanting a drawing's size goes through the cache.
- **An opened page promotes its layout.** Jobs carry an optional `layout`, and
  `prioritiseLayout` moves that layout's pending work to the front of every
  draining queue; `collab` calls it on page join. Any new queued work about a
  layout should carry the field, or it cannot be promoted.
- **Nothing slow goes on the critical path; queue it.** `runSoon` is the only way
  work should reach the filesystem at startup - watcher creation and sweeps
  included. Overlapping sweeps collapse through `scheduleRefresh`.
- **Cross-check the watchdog against the job timings.** It can say *that* the loop
  stalled; it can only name a cause when that job's own duration accounts for the
  stall. A blamed job with no matching `slow:` line means the blame is wrong.
- **Startup timing is in the log, not in a new build.** Jobs are labelled and
  timed, the inline passes too, `scanLayouts` and the drawing reads count their own
  cost, and a lag watchdog names whatever held the event loop. Read `server.log`
  before adding prints.
- **`scanLayouts` is *not* the bottleneck, whatever its shape suggests.** Being
  called once per resync makes it quadratic in sheets and it still measured 0.4s of
  a 43s startup. It was guessed first and was wrong; the cost was always the number
  of file opens against Dropbox. Measure before believing the next tidy story.
- **`parseLayout` retries while the file does not end in `</svg>`.** Bonsai's
  `tree.write` truncates before filling, and a parse failure looks exactly like a
  layout that places nothing.
- **A placement reports whether it moved.** `/api/bonsai/place` answers
  `moved`, and `false` means Bonsai added it at its own next free spot rather
  than at the click. Never report a placement as done without it.
- **Shift+A is ours and free.** The editor binds one shift-letter tool
  (Shift+X, autoshape) and matches plain letter tools only without shift, so a
  window listener can have it. It is skipped while an input, textarea or
  contenteditable has focus, and while the picker is open or something is
  waiting to be placed.
- **"Add to Sheet" is two steps on purpose:** pick, then click. The click is the
  position, so the dialog closes before it is taken. No editor patch is
  involved - the item is in the `MainMenu` we already compose, and the click is
  a capture-phase listener on the canvas container converted with
  `viewportCoordsToSceneCoords`.
- **Bonsai names a schedule or reference on a sheet by its file, not by the
  document's `Name`.** `import_sheets` builds `drawing_name_by_location` from
  `IfcAnnotation`s only, so a document row falls back to
  `os.path.basename(reference.Location)`. The two drift: `THINGER SCHEDULE` in
  `DOOR SCHEDULE.ods` is a real case from the troubleshooting model. The picker
  shows the file alongside the name when they differ, rather than picking a side.
- **A placement is named by GlobalId or by file, never assume the first.** The
  list holds drawings, schedules and references; a schedule and a reference are
  `IfcDocumentInformation`, so their `globalId` is empty and `/api/bonsai/place`
  takes `path` instead. `BonsaiDrawing.kind` says which, and `d.file` is also
  the React key, since `globalId` is not unique when it is empty.
- **A group key may carry `#2`.** `data-id` is not unique - IfcOpenShell reuses
  the ids of deleted entities - so `parseLayout` numbers repeats in document
  order and `findGroup` reads the suffix. Anything matching a key to a group
  must go through those two.
- **Ask the layout, not only the model, before adding a drawing to a sheet.**
  A removal that could not find the group leaves the layout placing a drawing
  the model has forgotten; a model-only check then permits a duplicate, and
  duplicates make the next removal ambiguous. `check_addable` checks both, and
  `remove_from_sheet` answers `stillPlaced` when the group survived.
- **Undo of a delete re-adds through Bonsai, from a remembered removal.** Only
  groups in `removedByUs` are put back, never "any live element the layout does
  not place" - that is also what a Bonsai-side removal looks like for a moment.
- **Template values are edited through Bonsai, never written.** `bonsaiEdit.ts`
  resolves a selected element to a view and asks the Blender holding that model
  (`getEditableFields`, `setTemplateValue`); nothing here writes a value into
  the `.ifc` or the layout. Which fields appear is `placeholdersIn` on the
  template; which can be written is Bonsai's answer, never a list kept here.
- **A drawing's size comes from the drawing, not the layout.** The layout keeps
  a stale box until Bonsai reflows the sheet, and drawing into it stretches the
  image (`resizeToDrawings`, mirroring `update_sheet_drawing_sizes` - the
  view-title tracks the bottom edge). Never write those sizes back: Bonsai owns
  them.
- **`httpServer.listen` comes first; everything else starts on the next tick.**
  Extraction, the bridge and the watcher all run from `startBackgroundWork`, and
  every piece of adoption goes through `runSoon`, one job per tick. Anything
  synchronous added ahead of `listen` is time the port is shut, which
  `open-layout.mjs` spends waiting with nothing on screen.
- **Never open the browser before the port answers.** The page is plain HTML
  with no retry; a browser that arrives early shows "connection refused" and
  stays there.
- **Never re-render a filled title as raw.** A title that cannot be matched to
  values keeps the image it has (`isUnmatched`); replacing it with
  `{{placeholders}}` reads as a fault. `CACHE_FORMAT` in `ifcValues.ts` must be
  bumped whenever `ifc_values.py` output changes shape, or stale cache entries
  are served until each model happens to change.
- **Extraction never runs in a CLI** (`enableIfcExtraction` is server-only).
  Scripts use the server's disk cache; a CLI would otherwise block on, or
  abandon, a read that takes seconds.
- **A values refresh is `templatesOnly`.** It swaps template images and nothing
  else - a full sync would re-read every drawing and snap back a title moved
  seconds ago.
- **Live values win over the saved file** (`setLiveValues`), and are dropped when
  Blender disconnects or stops answering for 15 s - a tab must never keep
  showing what a closed session last said.
- **The live and file paths must keep one shape** (`IfcExtract`). Bonsai's side
  is `SheetBuilder.get_template_values`, which calls the same methods its
  sheet build does; `ifc_values.py` mirrors *upstream* Bonsai. Where Ryan's
  build differs from upstream (drawing-name fallback, reference scales), live
  values follow the build and file values follow upstream.
- **Writing values back must go through Bonsai**, not the `.ifc` on disk;
  Blender holds the model in memory and would overwrite it.

### The Bonsai bridge

`bonsaiBridge.ts` joins Bonsai's own socket.io server (`sioserver.py`) as a
`/web` client and sends `web_operator` requests with `sourcePage: "sheets"`.

- **Bonsai's server forwards only events it has a handler for.** A reply under a
  new event name vanishes without error; `sheet_template_values` has one in
  `sioserver.py`.
- **`running_pid.json` keeps stale ports.** Every listed port is tried; a refused
  one is skipped for 30 s.
- **Loopback only.** Bonsai's server binds `127.0.0.1`, so the bridge needs
  SketchSpace and Blender on the same machine.
- **The Bonsai changes live in `C:\IfcOpenShell_worktrees\v0.8.0`** (Ryan's
  build branch). Blender runs Bonsai from a linked checkout, and which one
  changes - check before assuming:
  `(Get-Item "$env:APPDATA\Blender Foundation\Blender\5.2\extensions\.local\lib\python3.13\site-packages\bonsai" -Force).Target`.
  Upstream PRs are cherry-picked onto `v0.9.0` separately.
- **Blender does not run timers headless.** To test the bridge in
  `blender --background`, call `tool.Web.check_operator_queue()` in a loop
  yourself; everything else - the real server, the real client - is live.

## Verifying

`npm run smoke` drives three concurrent clients through auth, scene deltas,
conflict resolution, page isolation, presence, and persistence. All 18 checks
must pass. Point it at a throwaway `SKETCHSPACE_DATA_DIR` and port — see the
README. Run it after any change to `collab.ts`, `store.ts`, or `reconcile.ts`.
