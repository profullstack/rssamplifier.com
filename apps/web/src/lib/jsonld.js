/**
 * Serialising JSON-LD for a `<script>` tag, safely.
 *
 * Every structured-data block on the site was written the same way:
 *
 *     <script type="application/ld+json"
 *             dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
 *
 * and that is a stored cross-site scripting hole, because `JSON.stringify` has
 * no reason to escape `<`. It produces valid JSON; it does not produce a valid
 * *script body*. An HTML parser inside `<script>` is not looking for JSON, it is
 * looking for the string `</script>`, and it ends the element the moment it
 * finds one — inside a JSON string literal or not.
 *
 * So a feed whose title contains
 *
 *     </script><script>alert(document.domain)</script>
 *
 * closes the structured-data block early, and everything after it is a new,
 * attacker-controlled script running on our origin. That is not theoretical: it
 * was live on the home page, served to every visitor, from a feed submitted
 * through the public form.
 *
 * Escaping at output rather than at submission is deliberate and is the whole
 * point. A feed title is not ours — it is whatever the publisher's XML says, it
 * is re-read on every crawl, and there are 476,000 of them. A defence that
 * depends on catching the bad ones at the door has to be right every time
 * forever; escaping where the value meets the page has to be right once. React
 * already does exactly this for every other title on the page, which is why the
 * same string renders harmlessly in the `<h3>` a few lines below the payload.
 *
 * `&` and `>` come along because escaping only what is exploitable today is how
 * the next variant gets in, and the line terminators because they are legal in
 * JSON strings and illegal in JavaScript source — a block containing a raw
 * U+2028 is a syntax error rather than a vulnerability, but it is still broken.
 *
 * The output stays valid JSON: `<` inside a JSON string means `<` to every
 * parser, so Google and friends read exactly what they read before.
 */

/** @type {Record<string, string>} */
const ESCAPES = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/**
 * JSON for embedding in a `<script>` element.
 *
 * @param {unknown} data
 * @returns {string}
 */
export function jsonLdScript(data) {
  return JSON.stringify(data ?? null).replace(
    /[<>&\u2028\u2029]/g,
    (char) => ESCAPES[char] ?? char,
  );
}
