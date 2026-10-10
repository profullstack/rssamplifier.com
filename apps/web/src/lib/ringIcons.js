/**
 * The OpenIcon line glyphs the ring footer uses (github.com/profullstack/openicon,
 * keys `random` and `vote`), inlined so a member's footer fetches nothing. Same
 * 24-unit grid and 2px currentColor stroke as the set; sized 1em so they sit in a
 * line of text in whatever colour the footer already is. aria-hidden because the
 * anchor around each carries the label.
 */
const OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-0.125em">';

/** The body of each glyph, shared by the HTML snippet and the footer's JSX. */
export const RING_ICON_BODY = {
  random:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><circle cx="16" cy="8" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="16" r="1"/>',
  vote: '<path d="M12 4 21 19H3z"/>',
};

/**
 * @param {'random'|'vote'} name
 * @returns {string}
 */
export function ringIconSvg(name) {
  return `${OPEN}${RING_ICON_BODY[name]}</svg>`;
}
