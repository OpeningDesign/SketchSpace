/**
 * Take a consistent snapshot of the SketchSpace database.
 *
 *   npm run backup                          # snapshot to the default location
 *   npm run backup -- --out D:/Backups      # ...or anywhere you like
 *   npm run backup -- --timestamped --keep 14
 *
 * This deliberately knows nothing about Dropbox, restic, borg or anything else.
 * Its only job is to produce a consistent `.db` file at a path you choose; what
 * backs that path up is your business. Point `--out` (or SKETCHSPACE_BACKUP_DIR)
 * at a synced folder and you are done.
 *
 * Why a script rather than copying the file: the database runs in WAL mode, so
 * `.db`, `.db-shm` and `.db-wal` are only meaningful together and copying the
 * main file alone can capture a torn state. `VACUUM INTO` produces one
 * consistent, compacted file **while the server keeps running**.
 *
 * `VACUUM INTO` rather than the backup API on purpose: the backup API copies the
 * source's WAL mode with it, so the snapshot sprouts its own `-shm`/`-wal` the
 * moment anything opens it - three files again, and orphans left behind when an
 * old snapshot is pruned. `VACUUM INTO` writes a plain `journal_mode=delete`
 * database: one self-contained file, which is the whole point.
 *
 * Defaults chosen to suit whatever is downstream:
 *
 *   - **One stable filename**, overwritten each run. Dropbox versions a path,
 *     restic and borg deduplicate against the previous blob, rsync sends only
 *     deltas. Timestamped copies defeat all three, so they are opt-in.
 *   - **No compression.** A freshly compressed file differs everywhere and
 *     deduplicates terribly; every backup tool compresses better than we would.
 *   - **No retention** unless asked. restic has `forget`, borg has `prune`,
 *     Dropbox has version history - duplicating that would only get in the way.
 *
 * Assets (`<dataDir>/files`) are not copied here. They are content-addressed and
 * written once, never modified in place, so they are safe to copy while running
 * and any mirror tool handles them incrementally without help from us.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { config } from "../dist/server/config.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const has = (name) => args.includes(name);

const dataDir = path.resolve(config.dataDir);
const sourceDb = path.join(dataDir, "sketchspace.db");

// Default beside the data directory, not inside it - a backup living within the
// thing it backs up gets swept into the next mirror of that thing.
const outDir = path.resolve(
  flag("--out") ??
    process.env.SKETCHSPACE_BACKUP_DIR ??
    path.join(path.dirname(dataDir), "sketchspace-backups"),
);

const timestamped = has("--timestamped");
const keep = Number(flag("--keep") ?? 0);

if (!existsSync(sourceDb)) {
  console.error(`\nno database at ${sourceDb}\n`);
  process.exit(1);
}

const stamp = new Date()
  .toISOString()
  .replace(/[:T]/g, "-")
  .replace(/\..+$/, "");
const name = timestamped ? `sketchspace-${stamp}.db` : "sketchspace.db";
const dest = path.join(outDir, name);

mkdirSync(outDir, { recursive: true });

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

console.log(`\nsource : ${sourceDb}`);
console.log(`dest   : ${dest}`);

// Read-only: a backup must never be able to alter what it is backing up.
const source = new Database(sourceDb, { readonly: true });
const before = {
  boards: source.prepare("SELECT COUNT(*) n FROM boards").get().n,
  pages: source.prepare("SELECT COUNT(*) n FROM pages WHERE deleted = 0").get().n,
  scenes: source.prepare("SELECT COUNT(*) n FROM page_scenes").get().n,
};

// Write to a temporary name and rename into place: the rename is atomic on the
// same filesystem, so a backup tool reading this directory never catches a
// half-written snapshot. VACUUM INTO also refuses an existing destination.
const tmp = `${dest}.partial`;
try {
  if (existsSync(tmp)) {
    rmSync(tmp);
  }
  source.prepare("VACUUM INTO ?").run(tmp);
  renameSync(tmp, dest);
} catch (error) {
  if (existsSync(tmp)) {
    rmSync(tmp, { force: true });
  }
  console.error(`\nbackup failed: ${error.message}\n`);
  process.exit(1);
} finally {
  source.close();
}

/*
 * Verify what we just wrote. An untested backup is a hope, not a backup - and
 * the failure we would most regret is a snapshot that looks fine on disk and
 * turns out to be unreadable on the day it matters.
 */
const copy = new Database(dest, { readonly: true });
try {
  const integrity = copy.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    console.error(`\nsnapshot failed integrity check: ${integrity}\n`);
    process.exit(1);
  }

  const after = {
    boards: copy.prepare("SELECT COUNT(*) n FROM boards").get().n,
    pages: copy.prepare("SELECT COUNT(*) n FROM pages WHERE deleted = 0").get().n,
    scenes: copy.prepare("SELECT COUNT(*) n FROM page_scenes").get().n,
  };

  const mismatch = Object.keys(before).filter((k) => before[k] !== after[k]);
  if (mismatch.length > 0) {
    // Rows can legitimately change mid-backup if someone is drawing; say so
    // rather than failing, but do not let it pass silently.
    console.warn(
      `  note: ${mismatch
        .map((k) => `${k} ${before[k]} -> ${after[k]}`)
        .join(", ")} (the server was busy; the snapshot is still consistent)`,
    );
  }

  console.log(
    `\nok     : ${after.boards} board(s), ${after.pages} page(s), ` +
      `${mb(statSync(dest).size)}, integrity ok`,
  );
} finally {
  copy.close();
}

// Retention, only if asked and only for timestamped snapshots - a single stable
// filename has nothing to prune.
if (keep > 0 && timestamped) {
  const snapshots = readdirSync(outDir)
    .filter((f) => /^sketchspace-.*\.db$/.test(f))
    .sort()
    .reverse();
  for (const old of snapshots.slice(keep)) {
    rmSync(path.join(outDir, old));
    console.log(`  pruned ${old}`);
  }
}

// The assets are the other half of a restore; report them so their absence from
// this snapshot is never a surprise.
const filesDir = path.join(dataDir, "files");
if (existsSync(filesDir)) {
  const entries = readdirSync(filesDir);
  const total = entries.reduce(
    (sum, f) => sum + statSync(path.join(filesDir, f)).size,
    0,
  );
  console.log(
    `\nassets : ${entries.length} file(s), ${mb(total)} in ${filesDir}\n` +
      `         Not copied here - content-addressed and write-once, so they are\n` +
      `         safe to mirror live with any tool. Without them a restored board\n` +
      `         renders broken images.\n`,
  );
}
