import { randomBytes } from "node:crypto";

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
} as const;
