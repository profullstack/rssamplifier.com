/**
 * Reading a subscription list a piece at a time.
 *
 * The submit endpoint takes an OPML file as one multipart body and parses it
 * with a real XML parser, which is correct and has a size past which it stops
 * being possible: a 117 MB catalogue is minutes of upload before the server
 * sees a byte of it, and then a document tree of several hundred thousand nodes
 * held in memory to extract two attributes from each. The browser times out
 * first, so nothing is imported and nothing is reported.
 *
 * These functions are the other half of the fix — the uploader reads the file
 * locally, streams it past this scanner, and sends the feeds rather than the
 * file. Written to be lenient in the way a scanner has to be and a parser
 * cannot: it never holds the document, it never needs the document to be
 * well-formed, and it works on a chunk that begins and ends mid-tag.
 *
 * Deliberately free of imports so it costs the client bundle nothing but its
 * own bytes.
 */

/**
 * How much unterminated text is carried between chunks before giving up on it.
 *
 * A tag that never closes is a malformed file, not a big one, and the buffer
 * must not be allowed to grow to the size of the upload waiting for a `>` that
 * is not coming.
 */
const MAX_CARRY = 1_000_000;

/**
 * The five entities XML defines, plus numeric references.
 *
 * A feed URL with a query string is written `?a=1&amp;b=2` in an OPML
 * attribute, so this is not cosmetic: skip it and every such URL is queued with
 * a literal `&amp;` in it and fetched as a different address than the one the
 * catalogue named.
 *
 * @param {string} value
 * @returns {string}
 */
export function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * @param {number} n
 * @returns {string}
 */
function codePoint(n) {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/**
 * One attribute off an opening tag, decoded.
 *
 * Single quotes are accepted as well as double: OPML written by hand uses both,
 * and a scanner that only understands one silently reads half the file.
 *
 * @param {string} tag the whole `<outline …>` including its brackets
 * @param {string} name
 * @returns {string|null}
 */
export function attrOf(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  if (!match) return null;
  return decodeXml(match[2] ?? match[3] ?? '');
}

/**
 * Every `<outline>` opening tag in a fragment of OPML.
 *
 * @param {string} xml
 * @returns {string[]}
 */
export function outlineTags(xml) {
  return [...String(xml).matchAll(/<outline\b[^>]*>/gi)].map((m) => m[0]);
}

/**
 * The feeds a fragment of OPML names.
 *
 * An outline without an xmlUrl is a folder, not a feed, and is skipped — which
 * is also why nesting needs no special handling here. A folder contributes
 * nothing, so its children can simply be read as siblings.
 *
 * @param {string} xml
 * @returns {Array<{ url: string, title: string, siteUrl: string|null }>}
 */
export function scanOutlines(xml) {
  const out = [];

  for (const tag of outlineTags(xml)) {
    const url = attrOf(tag, 'xmlUrl');
    if (!url || !url.trim()) continue;

    // title before text, matching parseOpml: the two disagree often enough in
    // real exports that picking differently here would give the same file
    // different names depending on which path imported it.
    const title = attrOf(tag, 'title') || attrOf(tag, 'text') || '';
    const siteUrl = attrOf(tag, 'htmlUrl');

    out.push({
      url: url.trim(),
      title: title.trim(),
      siteUrl: siteUrl && siteUrl.trim() ? siteUrl.trim() : null,
    });
  }

  return out;
}

/**
 * The URLs a fragment of a plain list names.
 *
 * The same three delimiters the submit endpoint splits on — people separate
 * URLs with newlines, commas or spaces depending on where they copied from.
 *
 * @param {string} text
 * @returns {Array<{ url: string, title: string, siteUrl: null }>}
 */
export function scanUrls(text) {
  return String(text)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => ({ url, title: '', siteUrl: null }));
}

/**
 * A scanner that can be fed a file in pieces.
 *
 * Chunks arrive on arbitrary boundaries, so the tail of each one is held back
 * until the delimiter that would complete it turns up: everything after the
 * last `>` for OPML, after the last newline for a list. Without that, one
 * entry per chunk is torn in half — on a 117 MB file read in 64 KB pieces, that
 * is a couple of thousand feeds quietly lost.
 *
 * @param {'opml'|'list'} kind
 * @returns {{
 *   push: (chunk: string) => Array<{ url: string, title: string, siteUrl: string|null }>,
 *   end: () => Array<{ url: string, title: string, siteUrl: string|null }>,
 * }}
 */
export function createScanner(kind) {
  const scan = kind === 'opml' ? scanOutlines : scanUrls;
  const boundary = kind === 'opml' ? '>' : '\n';
  let carry = '';

  return {
    push(chunk) {
      const buffer = carry + String(chunk ?? '');
      const cut = buffer.lastIndexOf(boundary);

      if (cut === -1) {
        // Nothing complete yet. Holding on is right up to the point where it
        // stops being a large entry and starts being a file with no delimiters
        // in it at all, which would otherwise buffer the whole upload.
        if (buffer.length > MAX_CARRY) {
          carry = '';
          return scan(buffer);
        }
        carry = buffer;
        return [];
      }

      carry = buffer.slice(cut + 1);
      return scan(buffer.slice(0, cut + 1));
    },

    end() {
      const rest = carry;
      carry = '';
      return rest.trim() ? scan(rest) : [];
    },
  };
}

/**
 * Whether a file looks like OPML or like a plain list of URLs.
 *
 * By content first, then by name. The content test is the one that cannot be
 * wrong: `<opml` or `<outline` in the head of a file means the file is OPML
 * whatever it is called, and neither string occurs in a list of URLs. It used
 * to run last, which made the extension the decider and lost exactly the case
 * its own comment promised — a subscription export saved as `feeds.txt` was
 * scanned for URLs, and every one of its `<outline>` tags came back as a
 * handful of unusable tokens rather than a feed.
 *
 * The name still settles everything the content cannot, which is most files:
 * only a head that positively looks like OPML skips it.
 *
 * @param {{ name?: string }} file
 * @param {string} head the first few kilobytes of it
 * @returns {'opml'|'list'}
 */
export function sniffKind(file, head = '') {
  if (/<\s*(opml|outline)\b/i.test(String(head))) return 'opml';

  const name = String(file?.name ?? '').toLowerCase();
  if (/\.(opml|xml)$/.test(name)) return 'opml';
  return 'list';
}
