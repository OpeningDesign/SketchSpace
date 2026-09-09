# Notes

Lessons learned and where this might go. `README.md` describes how things work;
this is the running record of *why*, and what bit us on the way.

Most entries here exist because the failure was **silent** — something appeared
to work and quietly did nothing. Those are worth writing down; a loud error
teaches itself.

---

## Lessons learned

### Bonsai and IFC

**Read layouts, never built sheets.** Bonsai keeps `layouts/*.svg` (~3 KB of
structure and links) alongside `sheets/*.svg` (the build output — megabytes of
base64 PNG). The layout is the source: drawings regenerate from the model without
disturbing the arrangement, and a change is a readable git diff instead of a
binary blob. Anchoring anything to the built sheet is anchoring to a flattened
raster.

**Write the group `transform`, never image `x`/`y`.** `build_drawings` in
`sheeter.py` copies each `<g data-type="drawing">` into the built sheet with its
attributes intact, swapping only the `<image>` children — so the group transform
survives the build, while image `x`/`y` gets folded into an inner translate. It is
also what Inkscape writes when you drag a group. Writing `x`/`y` instead fights
Bonsai's own reflow logic.

**Position is `<g transform>` composed with `<image x/y>`.** Both are present in
the wild — Bonsai writes the latter, Inkscape the former. Read one and you get
drawings in the wrong place.

**Never re-serialise the layout XML.** String-replace the single attribute. A
round-trip through an XML writer reformats the whole file and destroys the small
diff that is the entire reason layouts exist.

**Read SVG attributes by local name, not by prefix.** Inkscape rewrites namespace
prefixes when it saves, and inconsistently: one sheet had `xlink:href`, another
bound the same namespace as `ns3` and wrote `ns3:href`. Matching the prefix made a
whole sheet parse to **zero placements with no error at all**.

**Bonsai writes the layout more often than you'd think** — `add_drawing`,
`remove_drawing`, `add_document`, and the two `update_*_sizes` reflows. Only
`build()` (i.e. `create_sheets`) leaves it alone. So Bonsai *moves* placements
too, which is why one-way sync was never going to hold.

**`data-drawing` is an IFC GlobalId.** Stable across regeneration, renaming and
re-arrangement — the right thing to anchor to. It is already written into every
placement; nothing has to be invented.

**A sheet has no identity of its own.** A layout SVG's root carries only
`id="root"`, and Bonsai renames the file when a sheet is renamed. Matching on
path therefore reads a rename as a new sheet: the old tab is orphaned and a
duplicate appears, which is exactly what happened in the field. The stable
identity is the *set* of drawing GlobalIds the layout places - that survives
renaming. Filenames also differ from Bonsai's display names, since Bonsai strips
commas when writing them.

**Watch the directory, not just the files.** A watcher bound to a path cannot see
a sibling appear or that path be renamed away, so new sheets never showed up and
renames duplicated. Reconciling the directory on adoption and at startup also
makes a board that drifted while the server was down heal itself.

**`fs.watch` is not recursive, and the thing that changed may not be the thing
you watch.** A redrawn titleblock lives in `layouts/titleblocks/`, which a watch
on `layouts/` cannot see; and even once seen, the layout's own content hash is
unchanged, so the normal sync path short-circuits. Two separate reasons for the
same silence. Watched directories are derived from each layout's resolved hrefs,
so they follow whatever Bonsai actually links to rather than an assumed layout.

**The model and the layout can disagree, and the layout is what we see.**
Bonsai's `remove_drawing` found a drawing's group by matching `data-id`, the
reference's STEP id, which does not survive a merge or any round trip that
renumbers entities. On a renumbered file the removal took the
`IfcDocumentReference` out of the model and left the group in the layout, with no
error - so Bonsai's Sheets panel showed the drawing gone while SketchSpace, which
reads layouts, still showed it. We were the ones who noticed, precisely because
we read the other source. Reported as
[IfcOpenShell#9468](https://github.com/IfcOpenShell/IfcOpenShell/issues/9468) and
fixed in [#9469](https://github.com/IfcOpenShell/IfcOpenShell/pull/9469); the
repair for an already-diverged sheet is to delete the orphaned `<g>` blocks from
the layout, keyed on `data-drawing`.

**Layouts can reference other repositories.** `A000` links into
`OD_Submodules/references/…` via a git submodule, so a board's assets may span
repos.

### Launching from Blender

**Bonsai's `layout_svg_command` is `Popen` with no shell.** Every argument is its
own JSON list entry, the executable must be resolvable by `shutil.which`, and the
literal token `path` is substituted with the layout's file path. Anything relative
resolves against Blender's working directory, not ours, so the whole command is
absolute. A shell-style string here fails silently - the button simply does
nothing.

**Do the database work before starting the server, not after.** Creating a board
while nothing is running cannot race the store, and the server's startup
reconcile then meets a finished board rather than one being assembled underneath
it. Ordering, again, rather than locking.

**A detached child needs somewhere to write.** `stdio: "ignore"` on a server
started from Blender means a failure to boot leaves nothing at all to look at -
no window, no console, no exit code anyone sees. Output goes to a log file, and
the "port never answered" message names it. Detached and `unref`'d because the
server must outlive both this script and Blender.

**"Is the server up?" gets exactly one implementation.** `server-control.mjs`
answers it for the autostart in `open-layout.mjs` and for the refusal in
`require-server-stopped.mjs` - the same question wanted both ways round. Two
copies of it is precisely the drift that produced the write-back bug above. A
related trap: the process runs as `node dist/server/index.js`, so matching
command lines for "sketchspace" finds nothing and reports "not running" while it
is plainly serving. Ask the port.

### Sync

**A readable file is not a complete one.** Bonsai and Inkscape truncate the
layout and write it again, so a watcher event can land mid-write. The partial
file still reads without error and still parses - it simply has fewer placements
than it should, and taking that at face value deletes every drawing on the
sheet. Ours did exactly that: 18 placements gone from a live page in one pass.
`readFileSync` succeeding says nothing about whether the writer has finished;
`syncLayout` now requires a closing `</svg>` before it will believe what it read.

**A deleted placement has to be revivable.** Once marked deleted, a placement
that came back in the layout matched on geometry, produced no update, and stayed
deleted forever - so removing a drawing from a sheet in Bonsai and putting it
back would never have worked. `syncPageWithLayout` treats a deleted element whose
placement is present again as a change in its own right.

Those two are a pair, and the second is what made the first survivable: reviving
the page was a matter of touching the layout, not restoring a backup.

**A write must refresh its own baseline.** After writing `groupTx` to the layout,
the element still held the old value, so the same delta looked pending forever and
every subsequent change rewrote every placement — one move wrote five. Echo
suppression meant the watcher wouldn't refresh it either: two mechanisms each
assuming the other would. If you suppress your own echo, you own the consequences
of it.

**Never write `page_scenes` directly while the server is running.** It caches open
pages in memory and writes them back on a debounce, so a direct database edit is
silently overwritten on the next flush — it appears to work, then vanishes minutes
later. `scripts/lib/require-server-stopped.mjs` exists because this ate a backfill.

**Content-addressed ids collide across boards.** `files.id` was a global PRIMARY
KEY while ids were content hashes, so the same image on a second board hit
`ON CONFLICT DO NOTHING` and was never registered to it — a broken placeholder
with the bytes sitting right there on disk. Keyed `(id, board_id)` now.

### Embedding Excalidraw

**The fallback main menu omits Preferences entirely.** `DefaultMainMenu` in
`LayerUI.tsx` has no `<MainMenu.DefaultItems.Preferences />`, so every preference
— including any you add to your own editor build — renders nowhere unless the host
app supplies its own `<MainMenu>`. Cost an hour of suspecting the vendoring.

**SVG-in-`<img>` is secure static mode.** It cannot fetch external resources at
all: no external images, no external CSS. So a raster underlay referenced
relatively inside a drawing SVG must be inlined as a data URL before the SVG
itself becomes one. Bonsai's `sioserver.py` inlines for exactly this reason.
Rewriting the reference to an HTTP URL does not help — it renders nothing.

**The viewport is readable and settable in scene coordinates.**
`getVisibleSceneBounds(appState)` returns `[x1, y1, x2, y2]` and
`setViewport({ target: bounds, fit })` takes them back, with `onScrollChange` to
know when to look. That is the whole of URL view sharing - no coordinate maths.

**A same-origin URL works as `dataURL`.** Excalidraw does `image.src = dataURL` on
a plain `new Image()`, so assets can be served over HTTP rather than embedded as
base64 in JSON. Same-origin also keeps the canvas untainted, so PNG/SVG export
still works.

**Vendoring the editor means tracking master.** `excalidrawAPI` became
`onExcalidrawAPI` in excalidraw#10870 after 0.18.1. Because `tsconfig` points at
the *vendored* types, `npm run typecheck` catches that class of break at build
time rather than in the browser. Always typecheck after `sync:editor`.

**`buildPackage.js` externalises the workspace siblings.** The 0.18.1 npm release
inlined them, which is why depending on the published package needed none of the
vendoring machinery. Building from master does — five packages plus ~31
third-party runtime imports.

### Working in the editor fork

**Update snapshots one file at a time.** Running `vitest --update` across several
files gave `history.test.tsx` a `number of renders` value of 3 where running it
alone produces 6 — the batch write baked in the wrong number, and the test then
failed on its own afterwards. It looked exactly like a regression from the change
under test, and only stashing and re-running on a clean tree distinguished the
two. Render counts are sensitive to how tests are batched; snapshot them the way
they normally run.

**Fork-only changes stay off the upstream PR branch.** Defaulting `wheelBehavior`
to `zoom` lives on `SketchSpace` and must not reach
`feat/wheel-zoom-preference` — the whole basis on which
[excalidraw#12051](https://github.com/excalidraw/excalidraw/pull/12051) is offered
is that existing behaviour is unchanged. `git log master..SketchSpace` is the
check: everything it lists is ours and deliberate.

### Backing up, and verifying

**Order beats simultaneity.** The database snapshot and the asset mirror do not
need to happen at the same instant - they need to happen in the right sequence.
Snapshot first, mirror after: everything the snapshot references was written
before it was taken, so a later mirror necessarily contains all of it, and the
few extra assets copied in between are harmless. The reverse order loses an asset
written in the gap, and you find out months later when a restore shows a broken
image.

**`VACUUM INTO`, not SQLite's backup API.** The backup API carries the source's
WAL mode across, so the "single file" snapshot grows its own `-shm`/`-wal` the
moment anything opens it, and pruning an old snapshot orphans them. `VACUUM INTO`
writes a plain `journal_mode=delete` database, and compacts it on the way.

**An untested backup is a hope.** Every run verifies with `integrity_check` and a
row count, and the restore procedure in the README was performed, not imagined -
a server booted from a snapshot, boards and tabs recovered, assets served.

**`cmd | tail && echo OK` reports `tail`'s exit code, not the command's.** It
prints OK over a failed build. Redirect to a file and test `$?` instead. This
nearly let a broken build through today.

**A build `EPERM` on `dist/` is not always Dropbox.** The running server serves
static files from `dist/client`, so Vite's `emptyOutDir` cannot delete it. Same
error text as the sync-lock failures, entirely different cause - stop the server
before building.

### Environment

**Keep the whole checkout out of Dropbox, not just the database.** The first
symptom was SQLite - WAL holds `.db`, `.db-shm` and `.db-wal` open together, and a
sync client locks them and syncs them out of step, giving "Device or resource
busy" on files nothing appears to have open. But the same cause produced
`unable to write file .git/objects/…: Invalid argument` mid-commit, a corrupted
commit-graph chain, and `EPERM` on `dist/client/assets` during a build. Marking a
folder with Dropbox's ignore attribute keeps it on disk while stopping the sync:

```powershell
Set-Content -Path 'D:\Dropbox\GitHub\SketchSpace' -Stream com.dropbox.ignored -Value 1
```

That removes it from Dropbox's cloud copy and other devices, so push first. A
retry usually clears a one-off failure; run `git fsck` afterwards if the failure
touched `.git`.

**"fetch failed" against a just-started server means it is still starting.** The
server adopts every board and registers a watcher per layout and per asset
directory *before* it listens, which on a machine with real projects takes
seconds. Backgrounding it and running straight into a script fails on the first
request, and the message reads like nothing is listening at all - which sent me
looking at IPv6 and `localhost` resolution before I checked the obvious. Both
were fine. `scripts/smoke.mjs` now waits for the port itself; anything else
scripted against a fresh server should too.

**`npm install` here takes minutes**, between Dropbox and native builds. Background
it.

---

## Roadmap

Roughly in order of value.

### Anchor redlines to the model

GlobalIds ride on every imported placement, but a redline is still just pixels on
a page. Binding an annotation to a GlobalId — and to a point in that drawing's
own coordinate space — is what makes it survive regeneration, and it is the
prerequisite for everything below it.

### BCF

Once redlines are anchored, export and import them as BCF topics. `src/bcf` in
IfcOpenShell is a working Python implementation to read the semantics off. This
is what makes SketchSpace interoperable with BIMcollab, Solibri, Revizto and
Bonsai's own BCF module, rather than a private format.

### Live bridge to Bonsai

Replace manual `import:sheets` with a connection to Bonsai's socket.io server on
the `/web` namespace. The read path needs **no upstream changes**: claim
`sourcePage: "drawings"` and `handle_drawings_operator` answers unmodified. Port
discovery is a read of `running_pid.json`. The write path — selecting an element
in Blender from a redline — needs a small `sourcePage: "sketchspace"` branch.

Worth upstreaming separately: `drawings_data` currently sends only `{name, path}`.
Adding the GlobalId is a two-line change and obviously useful to any consumer.

### Git as the issuance log

Ryan's project repos already encode issuances as commits
(`20260423 - to owner - design development review`). A redline belongs to a
commit; "which redlines were addressed between two issuances" should be a query,
not bookkeeping. Forgejo at hub.openingdesign.com is the host.

### Asset weight

Assets are now served as raw bytes over HTTP and cached immutably, which took a
sheet's metadata response from ~26 MB of base64 JSON to 1.7 KB. What remains is
the bytes themselves: one site plan is still 19.7 MB because its raster underlay
must be inlined into the SVG.

Two levers, neither pulled: gzip the asset endpoint (`node:zlib`, no new
dependency — SVG linework compresses ~80%, base64-of-PNG barely at all), and
downsample underlays at import, which is almost certainly the bigger win.

### Smaller things

- **The watcher fires two sync passes per external edit.** Converges correctly,
  but does twice the work. Likely Windows `fs.watch` plus Dropbox touching the
  file.
- **Undo history is not partitioned per page.** Switching pages uses
  `CaptureUpdateAction.NEVER` so the switch itself is not an undo step, but the
  histories are shared.
- **No offline queue.** A disconnected client keeps drawing; its changes are not
  replayed on reconnect.
- **Board management.** No way to delete or rename boards from the UI, and test
  imports accumulate.
- **Auth is one shared password.** Fine for a small trusted group; not
  multi-tenant. Real accounts would be a substantial piece of work.
- **Cross-page element links** — the other half of what
  [#6460](https://github.com/excalidraw/excalidraw/issues/6460) asked for, and
  natural for a drawing set where a section marker points at another sheet.
- **Backups go to one destination on one machine.** Nightly snapshots and the
  asset mirror both land in Dropbox, which covers the failure modes that actually
  happen - a bad migration, a deleted board, a dead disk. It does not cover the
  account itself. `BACKUP_DEST` is just a path, so a second scheduled run to
  another target is the whole of the fix; nobody has set one up.
- **Archiving finished projects.** Old boards keep their assets on disk and in
  every nightly mirror forever. Exporting a board to a self-contained file and
  removing it would keep the data directory proportional to live work.
