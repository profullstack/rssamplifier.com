/**
 * What a share puts on somebody else's screen.
 *
 * Two things get copied and they are not the same thing. A link is what you
 * paste into a chat that unfurls it for you; the blurb is what you paste into
 * one that does not — a mail, a note, a forum box — where a bare URL tells the
 * reader nothing about why it was sent.
 *
 * Composed on the server, because the text is the post's and the server is
 * where the post is. The button only puts it on the clipboard.
 */

/**
 * The readable text inside a body of HTML.
 *
 * Feed summaries arrive as markup often enough that copying one raw pastes
 * `<p>` tags into somebody's inbox. This is not a sanitizer and is not standing
 * in for one — nothing it returns is ever rendered as HTML — it only wants the
 * words.
 *
 * @param {unknown} html
 * @returns {string}
 */
export function plainText(html) {
  return String(html ?? '')
    // A block that ends without whitespace runs into the next one, so the tags
    // that separate paragraphs are worth a space before they go.
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    // The handful a feed actually ships. Anything else is left alone rather
    // than half-decoded.
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Shorten to a length, at a word boundary, without lying about where it stops.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function clamp(text, limit) {
  if (text.length <= limit) return text;

  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  // A single word longer than the limit has no boundary to break on; better a
  // hard cut than the whole thing.
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The blurb: what this is, roughly what it says, and where it lives.
 *
 * The summary is dropped when it only repeats the title, which is what a feed
 * that puts one sentence in both fields produces — and pasting the same line
 * twice reads as a bug in whatever sent it.
 *
 * @param {{ title: unknown, summary?: unknown, url: string, limit?: number }} post
 * @returns {string}
 */
export function shareText({ title, summary, url, limit = 280 }) {
  const heading = plainText(title);
  const gist = plainText(summary);

  // Compared before the clamp: a summary shortened to 280 characters no longer
  // equals a title it started out identical to.
  const body = gist.length > 0 && gist !== heading ? clamp(gist, limit) : '';

  return [heading, body, url].filter((line) => line.length > 0).join('\n\n');
}
