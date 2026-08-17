/**
 * HTML reduced to something a language model should be reading.
 *
 * The reader stores an extracted article as HTML, because that is what a
 * browser renders. An agent asking for the same article wants the prose: the
 * markup is tokens it pays for and then discards, and a model handed a wall of
 * `<div class="…">` reasons about the page instead of the writing.
 *
 * Deliberately not a parser. It runs on text we have already sanitised, and the
 * only structure worth keeping at this point is where the paragraphs were.
 *
 * @param {string|null|undefined} html
 * @returns {string}
 */
export function plainText(html) {
  if (!html) return '';

  return (
    String(html)
      // Script and style bodies are not prose, and are the one case where
      // dropping the tag but keeping the content would be actively wrong.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      // Where a paragraph ended, a paragraph should still end. Everything else
      // is inline as far as a reader is concerned.
      .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote|pre|tr)\s*>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      // Last, so an entity that decodes to an ampersand cannot be re-decoded
      // into something else by the replacements above it.
      .replace(/&amp;/gi, '&')
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Cut text to a budget without ending mid-word.
 *
 * A tool result is somebody's context window. A 60,000-word article returned in
 * full is not more useful than the first few thousand words plus a link to the
 * rest — it is the same answer with less room left to think about it.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {{ text: string, truncated: boolean }}
 */
export function clip(text, limit) {
  if (text.length <= limit) return { text, truncated: false };

  const cut = text.slice(0, limit);
  const boundary = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf(' '));

  return {
    text: `${cut.slice(0, boundary > limit * 0.5 ? boundary : limit).trimEnd()}…`,
    truncated: true,
  };
}
