/**
 * Timestamps on every line the server prints.
 *
 * The log is appended to across sessions - `open-layout.mjs` starts the server
 * detached and points its output here - so "it was slow that time" is a
 * question about a particular minute, and an untimed log cannot answer it. That
 * is not hypothetical: working out where twelve seconds of startup went meant
 * reconstructing it from the outside, because nothing in the log said when
 * anything happened.
 *
 * Local time, not UTC: it is read beside a wall clock, by the person who was
 * sitting here. Milliseconds, because the things worth timing here take
 * hundreds of them.
 */
const stamp = (): string => {
  const now = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.` +
    pad(now.getMilliseconds(), 3)
  );
};

/**
 * Prefix console output. Called once, before anything else logs.
 *
 * The prefix goes on the first argument only when it is a string, so
 * `console.log(obj)` and multi-argument calls still read as they did.
 */
export const startTimestampingLogs = (): void => {
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (typeof args[0] === "string") {
        original(`${stamp()} ${args[0]}`, ...args.slice(1));
      } else {
        original(stamp(), ...args);
      }
    };
  }
};

/** Seconds since `from`, to one decimal - for "ready in 0.4s". */
export const since = (from: number): string => `${((Date.now() - from) / 1000).toFixed(1)}s`;
