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

/* ------------------------------ where time goes ----------------------------- */

/**
 * Run something and say how long it took, if that was long enough to matter.
 *
 * A total is not a diagnosis. "boards adopted in 324.5s" was true for months and
 * said nothing about which of sixty-five layouts spent it, so the next question
 * always needed a new build. Anything on the startup path that can be slow is
 * wrapped in this instead, and a fast run stays silent.
 */
export const timed = <T>(label: string, fn: () => T, thresholdMs = 250): T => {
  const started = Date.now();
  try {
    return fn();
  } finally {
    const took = Date.now() - started;
    if (took >= thresholdMs) {
      console.log(`[sketchspace] slow: ${label} took ${(took / 1000).toFixed(1)}s`);
    }
  }
};

/**
 * What is running right now, for the watchdog to name.
 *
 * Set around each unit of deferred work. Null when nothing is in flight, so a
 * stall with nothing set is the event loop being held by something that is not
 * going through the job runner - which is itself the useful half of the answer.
 */
let currentWork: string | null = null;
let startedWorkAt = 0;
/**
 * The job that finished most recently, and when.
 *
 * Needed because the work is synchronous: a job that blocks for five seconds has
 * already cleared its label by the time the watchdog's timer gets a turn, so
 * reading only `currentWork` reports every stall as "no job in flight" - which is
 * what the first test of this did.
 */
let lastWork: { label: string; endedAt: number } | null = null;

export const setCurrentWork = (label: string | null): void => {
  if (label === null && currentWork !== null) {
    lastWork = { label: currentWork, endedAt: Date.now() };
  }
  if (label !== null) {
    startedWorkAt = Date.now();
  }
  currentWork = label;
};

/** What to blame for a stall that ended `lag` ms ago and is being reported now. */
const blameFor = (lag: number): string => {
  if (currentWork) {
    return ` during ${currentWork}, ${((Date.now() - startedWorkAt) / 1000).toFixed(1)}s in so far`;
  }
  // Did the job that just finished overlap the stall? If so it is the culprit,
  // and saying "just finished" keeps it honest about the timing.
  if (lastWork && lastWork.endedAt >= Date.now() - lag) {
    return ` during ${lastWork.label}, which had just finished`;
  }
  return " with no job in flight - something outside the job runner held it";
};

/**
 * Notice when the event loop stops turning, and say what was in flight.
 *
 * Everything here is synchronous - reading and hashing drawings, parsing SVG,
 * SQLite - so a "hang" is one job holding the loop rather than anything being
 * deadlocked. A timer that expects to fire every `intervalMs` and fires late by
 * more than `thresholdMs` measures exactly that, and is nearly free.
 *
 * Reports at most once per stall, because a five-second block would otherwise
 * produce one line per missed tick.
 */
export const startLagWatchdog = (intervalMs = 500, thresholdMs = 1500): (() => void) => {
  let expected = Date.now() + intervalMs;
  const timer = setInterval(() => {
    const lag = Date.now() - expected;
    expected = Date.now() + intervalMs;
    if (lag >= thresholdMs) {
      console.warn(
        `[sketchspace] event loop blocked for ${(lag / 1000).toFixed(1)}s${blameFor(lag)}`,
      );
    }
  }, intervalMs);
  // Never hold the process open for the sake of watching it.
  timer.unref();
  return () => clearInterval(timer);
};
