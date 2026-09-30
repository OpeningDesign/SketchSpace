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
let lastWork: { label: string; endedAt: number; tookMs: number } | null = null;

/**
 * @param tookMs How long the finishing job ran. Required to blame it for a stall:
 *   a job that ran for 200ms cannot be the reason the loop stopped for 20s, and
 *   saying it was is worse than saying nothing.
 */
export const setCurrentWork = (label: string | null, tookMs = 0): void => {
  if (label === null && currentWork !== null) {
    lastWork = { label: currentWork, endedAt: Date.now(), tookMs };
  }
  if (label !== null) {
    startedWorkAt = Date.now();
  }
  currentWork = label;
};

/**
 * How recently a finished job must have ended to be worth blaming.
 *
 * Fixed and small on purpose. Blaming anything that finished within the whole
 * stall - which the first version did - means a 78s block names whatever job
 * happened to end in the last 78 seconds, which is almost always innocent. It
 * read as a confident answer and was noise. A job that ended within a tick or two
 * of the stall beginning is a real suspect; anything older is not.
 */
const BLAME_GRACE_MS = 250;

/** What to blame for a stall that ended `lag` ms ago and is being reported now. */
const blameFor = (lag: number): string => {
  if (currentWork) {
    return ` during ${currentWork}, ${((Date.now() - startedWorkAt) / 1000).toFixed(1)}s in so far`;
  }
  // A job that blocked the loop itself clears its label when it finally returns,
  // which is the *end* of the stall - so a suspect has to have ended just now AND
  // to have run for most of the stall.
  //
  // Both halves are needed. Node drains the immediate queue before it runs timers,
  // so after a stall this callback fires *after* the next batch of jobs, and the
  // one that just finished is usually innocent. Checking only recency produced
  // confident nonsense: "blocked for 20.0s during reconcile Bonsai/layouts" for a
  // reconcile that the queue had timed at under half a second.
  if (
    lastWork &&
    Date.now() - lastWork.endedAt <= BLAME_GRACE_MS &&
    lastWork.tookMs >= lag / 2
  ) {
    return ` during ${lastWork.label}, which took ${(lastWork.tookMs / 1000).toFixed(1)}s of it`;
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
