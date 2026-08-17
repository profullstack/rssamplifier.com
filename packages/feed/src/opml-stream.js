/**
 * Read an OPML document as a stream of outlines instead of a parsed tree.
 *
 * `parseOpml` builds the whole document with fast-xml-parser, which is right
 * for a subscription export and wrong for a catalogue: measured on this
 * machine, 256 MiB of OPML parsed to 3.4 million feeds cost 2.6 GB resident and
 * thirty seconds, roughly ten times the file in memory. Above 512 MiB it cannot
 * run at all, because that is Node's maximum string length and the upload never
 * becomes a string.
 *
 * So an upload big enough to be worth queueing is scanned rather than parsed.
 * The scanner holds one partial tag, never the document, so memory is flat in
 * the size of the file and an import is bounded by how long the client takes to
 * send it rather than by how much of it fits in the heap.
 *
 * What is given up is nesting: a scanner cannot know which folder an outline
 * sat in. Nothing downstream ever used that — `parseOpml` flattens the tree and
 * keeps only the nodes carrying `xmlUrl` — so the two agree on every document
 * either of them can read, which `opml-stream.test.js` asserts directly.
 */

/**
 * Longest a single `<outline …>` tag may run before it is abandoned.
 *
 * The buffer holds an unterminated tag until its `>` arrives, so without a
 * ceiling a file containing one stray `<outline` and then a gigabyte of prose
 * would buffer the gigabyte. Real outlines are a few hundred bytes; anything
 * past this is not a tag that got split across chunks, it is a file that has no
 * closing bracket to find.
 */
const MAX_TAG = 64 * 1024;

/** Longest prefix of `<outline` that a chunk boundary can leave behind. */
const KEEP = '<outline'.length - 1;

const OPEN = /<outline\b/gi;

/**
 * Raised when a stream runs past the byte ceiling it was given.
 *
 * A distinct type rather than a plain Error so a caller can answer 413 for this
 * and 400 for a malformed upload, without matching on message text.
 */
export class OpmlTooLargeError extends Error {
  /** @param {number} limit */
  constructor(limit) {
    super(`OPML upload exceeds ${limit} bytes`);
    this.name = 'OpmlTooLargeError';
    this.limit = limit;
  }
}

/**
 * Every feed an OPML stream lists, yielded as it is read.
 *
 * @param {AsyncIterable<Uint8Array|string>|Iterable<Uint8Array|string>} source
 * @param {{ maxBytes?: number, onBytes?: (total: number) => void }} [opts]
 * @returns {AsyncGenerator<{ url: string, title: string, siteUrl: string|null }>}
 */
export async function* streamOpmlOutlines(source, opts = {}) {
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;

  // 'fatal: false' matters: a multi-gigabyte upload is not going to be rejected
  // over one bad byte in the middle of it, and a replacement character in a
  // feed title is a far better outcome than a failed import.
  const decoder = new TextDecoder('utf-8', { fatal: false });

  let buffer = '';
  let bytes = 0;

  for await (const chunk of source) {
    if (typeof chunk === 'string') {
      bytes += Buffer.byteLength(chunk, 'utf8');
      buffer += chunk;
    } else {
      bytes += chunk.byteLength;
      // Streaming decode, so a multi-byte character split across two chunks is
      // held back rather than mangled into two replacement characters.
      buffer += decoder.decode(chunk, { stream: true });
    }

    if (bytes > maxBytes) throw new OpmlTooLargeError(maxBytes);
    opts.onBytes?.(bytes);

    const consumed = yield* drain(buffer, false);
    buffer = buffer.slice(consumed);
  }

  buffer += decoder.decode();
  yield* drain(buffer, true);
}

/**
 * Yield every complete outline in `buffer` and report how much of it is done
 * with.
 *
 * The leftover is whatever might still be the start of a tag: an unterminated
 * `<outline`, or up to seven trailing characters that could be a chunk boundary
 * landing inside the literal `<outline` itself. Getting that second case wrong
 * is the classic streaming-scanner bug — the tag is complete in the file and
 * invisible to the scanner, so a feed goes missing for no reason a log will
 * ever show.
 *
 * @param {string} buffer
 * @param {boolean} final
 * @returns {Generator<{ url: string, title: string, siteUrl: string|null }, number>}
 */
function* drain(buffer, final) {
  let at = 0;
  OPEN.lastIndex = 0;

  for (;;) {
    OPEN.lastIndex = at;
    const open = OPEN.exec(buffer);

    if (!open) {
      if (final) return buffer.length;
      // Nothing here opens a tag, so everything but a possible partial `<outline`
      // is finished with.
      return Math.max(at, buffer.length - KEEP);
    }

    const start = open.index;
    const end = buffer.indexOf('>', start);

    if (end === -1) {
      if (final) return buffer.length;
      // An unterminated tag: keep it and wait for the rest, unless it has run
      // so long that no rest is coming.
      return buffer.length - start > MAX_TAG ? buffer.length : start;
    }

    const tag = buffer.slice(start, end + 1);
    const url = attr(tag, 'xmlUrl');

    if (url) {
      const siteUrl = attr(tag, 'htmlUrl');
      yield {
        url,
        title: attr(tag, 'title') ?? attr(tag, 'text') ?? '',
        siteUrl: siteUrl || null,
      };
    }

    at = end + 1;
  }
}

/**
 * @param {string} tag
 * @param {string} name
 * @returns {string|null}
 */
function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  if (!match) return null;

  const value = decode((match[2] ?? match[3] ?? '').trim());
  return value || null;
}

/**
 * The five entities XML defines. `&amp;` is unescaped last, so that an
 * `&amp;lt;` in a title decodes to the text `&lt;` and not to a `<`.
 *
 * @param {string} value
 * @returns {string}
 */
function decode(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
