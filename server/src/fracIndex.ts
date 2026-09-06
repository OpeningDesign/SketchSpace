/**
 * Fractional indexing for page order.
 *
 * Pages are ordered by an opaque string key. Inserting between two pages mints
 * a key strictly between their keys, so two people reordering concurrently
 * converge without a coordinator - the same trick Excalidraw uses for element
 * z-order (packages/element/src/fractionalIndex.ts).
 *
 * This is a deliberately small implementation: page counts are tiny and we only
 * ever need "give me a key between a and b".
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Returns a key strictly between `a` and `b`.
 * Pass `null` for `a` to mean "before everything", `null` for `b` to mean
 * "after everything".
 */
export const indexBetween = (a: string | null, b: string | null): string => {
  const lo = a ?? "";
  const hi = b ?? "";

  if (hi !== "" && lo >= hi) {
    throw new Error(`indexBetween expects a < b, got ${lo} >= ${hi}`);
  }

  let prefix = "";
  let i = 0;

  // Walk both keys digit by digit until there is room to slot a digit between
  // them; until then, copy the shared prefix and keep descending.
  for (;;) {
    const loDigit = i < lo.length ? DIGITS.indexOf(lo[i]!) : -1;
    const hiDigit =
      hi !== "" && i < hi.length ? DIGITS.indexOf(hi[i]!) : DIGITS.length;

    if (hiDigit - loDigit > 1) {
      const mid = loDigit + Math.floor((hiDigit - loDigit) / 2);
      return prefix + DIGITS[mid]!;
    }

    prefix += i < lo.length ? lo[i]! : DIGITS[0]!;
    i++;
  }
};

/** Key for the first page of a brand new board. */
export const firstIndex = (): string => indexBetween(null, null);
