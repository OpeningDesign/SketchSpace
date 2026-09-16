/**
 * Attribute edits on SVG text, without parsing it.
 *
 * Layouts are hand-diffed in git, so they are edited as text: re-serialising the
 * XML would reformat the whole file. These are the only primitives that edit it.
 */

export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Set one attribute on a tag, by whole name - `x` must not hit `data-x`.
 *
 * Replacements go through functions: a `$` in a value would otherwise be read
 * as a replacement pattern.
 */
export const setAttr = (tag: string, name: string, value: string): string => {
  const attr = `${name}="${value}"`;
  const re = new RegExp(`(\\s)${escapeRegExp(name)}\\s*=\\s*"[^"]*"`);
  return re.test(tag)
    ? tag.replace(re, (_match, space: string) => `${space}${attr}`)
    : tag.replace(/(\s*\/?>)$/, (end) => ` ${attr}${end}`);
};
