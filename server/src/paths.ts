import path from "node:path";

/**
 * One spelling for a path, so the same file compares equal however it was
 * written - Bonsai writes backslashes, the layout parser resolves, Windows
 * ignores case. Every comparison of project paths goes through this.
 */
export const normalisePath = (p: string): string =>
  path.resolve(p).replace(/\\/g, "/").toLowerCase();
