/**
 * The matching behind <ListFilter>, kept out of the component so it can be
 * tested without a browser.
 *
 * It also has to live outside that file for a second reason worth keeping:
 * <ListFilter> is a client module, and every export of a client module read
 * from a server component comes back as a reference to the client rather than
 * as the value. `rows.length >= FILTER_FROM` against one of those is quietly
 * false, which renders no filter at all and no error to say why. A plain module
 * cannot do that.
 */

/**
 * How many rows a list needs before a filter earns its place above it.
 *
 * A box that narrows six rows is furniture: you can already see all six. The
 * pages import this rather than each picking a number, so the site is
 * consistent about where the line falls.
 */
export const FILTER_FROM = 12;

/**
 * Lower-case, de-accented, single-spaced text, so that "Café" matches "cafe"
 * and a row whose markup wraps its title across three lines still matches on
 * the whole phrase.
 *
 * @param {string} s
 * @returns {string}
 */
export function normalise(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What someone typed, as the list of words a row has to contain.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function terms(query) {
  return normalise(query).split(' ').filter(Boolean);
}

/**
 * Does this row's text satisfy every term?
 *
 * Every term has to appear somewhere in the row, in any order: "rust async"
 * should find a post about async Rust however its title arranges those two
 * words, which a single-substring match would miss. Substrings rather than
 * whole words, because someone typing "garden" is looking for "gardening".
 *
 * @param {string} haystack text already through {@link normalise}
 * @param {string[]} wanted
 * @returns {boolean}
 */
export function matches(haystack, wanted) {
  return wanted.every((t) => haystack.includes(t));
}
