import { randomBytes } from "node:crypto";
import path from "node:path";

const password = process.env.SKETCHSPACE_PASSWORD;
if (!password) {
  throw new Error(
    "SKETCHSPACE_PASSWORD is not set. Refusing to start an instance with no gate.",
  );
}

let sessionSecret = process.env.SKETCHSPACE_SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = randomBytes(32).toString("hex");
  console.warn(
    "[sketchspace] SKETCHSPACE_SESSION_SECRET is not set - generated an ephemeral one. " +
      "Everyone will be logged out on every restart. Set it in .env for a real deployment.",
  );
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir: process.env.SKETCHSPACE_DATA_DIR ?? "./data",
  password,
  sessionSecret,
  /** How long a login lasts. */
  sessionMaxAgeMs: 1000 * 60 * 60 * 24 * 30,
  /** How long a page sits dirty in memory before being written to SQLite. */
  persistDebounceMs: 1000,
  /** How long a page stays cached in memory after its last viewer leaves. */
  pageEvictionMs: 1000 * 60 * 5,
  /**
   * A Python with ifcopenshell, used to read the values Bonsai fills into
   * view-titles and titleblocks. Without one, those show their raw
   * `{{placeholders}}` and everything else works as before.
   */
  python: process.env.SKETCHSPACE_PYTHON ?? "python",
  /**
   * Take template values live from Bonsai when Blender is connected - including
   * unsaved edits - rather than only from the saved file. "off" disables it.
   */
  bonsaiBridge: process.env.SKETCHSPACE_BONSAI_BRIDGE !== "off",
  /**
   * Where Bonsai's web server records its ports (`running_pid.json`), separated
   * by the platform's path delimiter. Empty means: look in every Blender
   * version's user directory.
   */
  bonsaiWebuiDirs: (process.env.SKETCHSPACE_BONSAI_WEBUI ?? "")
    .split(path.delimiter)
    .filter(Boolean),
} as const;
