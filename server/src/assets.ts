/**
 * Board assets on disk.
 *
 * Files are stored as **raw bytes** and served from an HTTP endpoint, rather
 * than as `data:` URLs embedded in JSON. Excalidraw loads an image with
 * `image.src = dataURL` on a plain `new Image()`, so a same-origin URL works
 * just as well - and being same-origin keeps the canvas untainted, so PNG and
 * SVG export still work.
 *
 * That change buys three things on a real drawing set, where assets run to
 * hundreds of megabytes:
 *
 *   - no base64 expansion (~33%) on disk or on the wire;
 *   - browser caching, since ids are content hashes and can be served immutable,
 *     so a title block shared by fourteen sheets is fetched once;
 *   - no multi-megabyte JSON to parse - images load lazily and in parallel.
 *
 * What this does NOT fix: raster underlays referenced *inside* a drawing SVG
 * still have to be inlined as data URLs. An SVG loaded through <img> runs in
 * secure static mode and cannot fetch external resources at all, so an HTTP
 * reference there simply renders nothing. Bonsai's sioserver.py inlines for the
 * same reason.
 */
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { config } from "./config.js";

const filesDir = () => path.join(config.dataDir, "files");

export const assetPath = (boardId: string, fileId: string): string =>
  path.join(filesDir(), `${boardId}.${fileId}`);

export const writeAsset = (
  boardId: string,
  fileId: string,
  bytes: Buffer,
): void => {
  writeFileSync(assetPath(boardId, fileId), bytes);
};

export const readAsset = (boardId: string, fileId: string): Buffer =>
  readFileSync(assetPath(boardId, fileId));

/** `data:<mime>;base64,<payload>` -> bytes. Returns null if not a data URL. */
export const decodeDataURL = (
  value: string,
): { mimeType: string; bytes: Buffer } | null => {
  const match = /^data:([^;,]+)(;base64)?,/.exec(value);
  if (!match) {
    return null;
  }
  const payload = value.slice(match[0].length);
  return {
    mimeType: match[1] ?? "application/octet-stream",
    bytes: match[2]
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8"),
  };
};

/** The URL an element's `dataURL` points at. Same-origin, so it just works. */
export const assetUrl = (boardId: string, fileId: string): string =>
  `/api/boards/${boardId}/assets/${fileId}`;

/**
 * One-time migration: assets used to be stored as `data:` URL text. Rewrite any
 * that still are, which also reclaims the base64 overhead.
 */
export const migrateDataUrlAssets = (): void => {
  let converted = 0;
  let saved = 0;

  let entries: string[];
  try {
    entries = readdirSync(filesDir());
  } catch {
    return;
  }

  for (const name of entries) {
    const full = path.join(filesDir(), name);
    try {
      if (!statSync(full).isFile()) {
        continue;
      }
      // Cheap probe: only data URLs start with "data:".
      const head = readFileSync(full).subarray(0, 5).toString("latin1");
      if (head !== "data:") {
        continue;
      }
      const decoded = decodeDataURL(readFileSync(full, "utf8"));
      if (!decoded) {
        continue;
      }
      const before = statSync(full).size;
      const tmp = `${full}.tmp`;
      writeFileSync(tmp, decoded.bytes);
      renameSync(tmp, full);
      converted++;
      saved += before - decoded.bytes.length;
    } catch (error) {
      console.error(`[sketchspace] could not migrate asset ${name}:`, error);
    }
  }

  if (converted > 0) {
    console.log(
      `[sketchspace] converted ${converted} asset(s) from data URLs to raw bytes, ` +
        `reclaiming ${(saved / 1024 / 1024).toFixed(0)} MB`,
    );
  }
};
