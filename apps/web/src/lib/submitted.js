import { parseOpml } from '@rssamplifier/feed';

/**
 * How much of a submission's input is kept, counted in lines.
 *
 * The submit route stores this much of what was uploaded and no more, because
 * the audit trail exists to identify a submission rather than to hold a second
 * copy of it. Exported so the status page can tell "this is all of it" from
 * "this is the first part of it" by the same number the writer used, rather
 * than by a literal that drifts.
 *
 * Lines, not characters, because a line is the unit the submitter works in:
 * both the paste box and an OPML export put one feed on one line, so a cap of
 * fifty thousand lines is a promise about fifty thousand feeds. The old cap of
 * ten thousand *characters* was the same idea measured in the wrong unit, and
 * it was far tighter than it read — a couple of hundred pasted URLs already ran
 * past it, so the status page called uploads truncated that were nothing of the
 * sort.
 */
export const RAW_INPUT_LINE_LIMIT = 50_000;

/**
 * A second cap, on bytes, for the shape the line cap cannot see.
 *
 * A minified OPML is one very long line, and plenty of exporters emit exactly
 * that — for such a file "the first fifty thousand lines" is the whole
 * document, however many megabytes it runs to, and the cap would quietly do
 * nothing. Sized so it can only ever bite that degenerate case: fifty thousand
 * lines of even the longest realistic OPML outline is comfortably under it, so
 * a normal upload is decided by the line cap alone.
 */
export const RAW_INPUT_BYTE_LIMIT = 16 * 1024 * 1024;

/** Entries listed on the status page before it starts summarising. */
export const PREVIEW_LIMIT = 30;

/**
 * The offset just past the `max`th line of `text`, or -1 if it has no more
 * lines than that.
 *
 * Scans for newlines rather than splitting, because the input this runs on is
 * the case the cap exists for: splitting a multi-megabyte catalogue would build
 * an array of every line in it purely to throw all but the head away.
 *
 * @param {string} text
 * @param {number} max
 * @returns {number}
 */
function endOfLine(text, max) {
  let at = -1;

  for (let seen = 0; seen < max; seen++) {
    const next = text.indexOf('\n', at + 1);
    if (next === -1) return -1;
    at = next;
  }

  return at;
}

/**
 * Cut a submission down to the copy that gets stored.
 *
 * The writer's half of the cap: every caller that writes `raw_input` goes
 * through here, so the stored copy and the status page's reading of it can
 * never disagree about where the cut is.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function clampRawInput(raw) {
  const text = String(raw ?? '');

  const cut = endOfLine(text, RAW_INPUT_LINE_LIMIT);
  const byLines = cut === -1 ? text : text.slice(0, cut);

  return byLines.length > RAW_INPUT_BYTE_LIMIT ? byLines.slice(0, RAW_INPUT_BYTE_LIMIT) : byLines;
}

/**
 * Collect the stored copy from an upload that is still arriving.
 *
 * `clampRawInput` wants the whole text, which a streamed upload does not have
 * and must not assemble. So the head is gathered chunk by chunk and the scan is
 * done once, at the end, over what was gathered — never over the upload.
 *
 * Newlines are counted per chunk rather than re-scanned from the start each
 * time. Re-scanning would be O(n²) in the number of chunks, which on a 16 MiB
 * head arriving in 64 KiB pieces is gigabytes of pointless work.
 *
 * @returns {{ add: (text: string) => boolean, value: () => string }}
 */
export function rawInputCollector() {
  let buffer = '';
  let newlines = 0;
  let full = false;

  return {
    /**
     * Add a chunk. Returns false once no further chunk can change the result,
     * which is the caller's cue to stop handing them over.
     */
    add(text) {
      if (full) return false;

      buffer += text;
      for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) newlines += 1;

      if (newlines >= RAW_INPUT_LINE_LIMIT || buffer.length >= RAW_INPUT_BYTE_LIMIT) {
        buffer = clampRawInput(buffer);
        full = true;
        return false;
      }

      return true;
    },

    value() {
      return full ? buffer : clampRawInput(buffer);
    },
  };
}

/**
 * Whether a stored copy is all of what was uploaded or only the head of it.
 *
 * Inferred from the stored text rather than recorded at write time, so that
 * rows written before the cap moved are still read by the cap they were written
 * under — a submission sitting exactly on the limit is reported as truncated,
 * which is the honest answer when the writer cannot tell either.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function wasTruncated(raw) {
  if (raw.length >= RAW_INPUT_BYTE_LIMIT) return true;
  return endOfLine(raw, RAW_INPUT_LINE_LIMIT - 1) !== -1;
}

/**
 * What somebody actually submitted, in a shape a page can render.
 *
 * The status page could say how a submission turned out but never what it was:
 * an OPML import was 237 feeds crawled with no way to tell which file that came
 * from, which matters most in the case you are looking at the page for — two
 * uploads, one of them wrong, and no way to tell them apart.
 *
 * @param {{ kind?: unknown, raw_input?: unknown }} submission
 * @returns {{
 *   kind: 'url'|'list'|'opml',
 *   label: string,
 *   title: string|null,
 *   owner: string|null,
 *   entries: Array<{ url: string, title: string|null }>,
 *   total: number,
 *   truncated: boolean,
 * }|null}
 */
export function describeSubmittedInput(submission) {
  const raw = typeof submission?.raw_input === 'string' ? submission.raw_input : '';
  if (!raw.trim()) return null;

  const kind = submission?.kind === 'opml' || submission?.kind === 'list' ? submission.kind : 'url';
  const truncated = wasTruncated(raw);

  if (kind !== 'opml') {
    const urls = raw
      .split(/[\s,]+/)
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      kind,
      label: kind === 'list' ? 'A list of feeds' : 'One feed',
      title: null,
      owner: null,
      entries: urls.slice(0, PREVIEW_LIMIT).map((url) => ({ url, title: null })),
      total: urls.length,
      truncated,
    };
  }

  return {
    kind: 'opml',
    label: 'An OPML file',
    title: tagText(raw, 'title'),
    owner: tagText(raw, 'ownerName'),
    ...outlines(raw),
    truncated,
  };
}

/**
 * The outlines an OPML document lists, however complete the document is.
 *
 * The strict parser first, because it is the one that understands nesting and
 * entities. It cannot help here in the common case, though: only the
 * head of an upload is stored, and a catalogue longer than the cap is cut at a
 * line boundary that lands mid-tag as often as not, and a document cut mid-tag is malformed — the parser returns
 * nothing at all for a file whose first sixty entries are perfectly readable.
 *
 * So a lenient scan stands behind it. Wrong shape for parsing OPML in general,
 * exactly right for reading as much of a truncated one as survives.
 *
 * @param {string} xml
 * @returns {{ entries: Array<{ url: string, title: string|null }>, total: number }}
 */
function outlines(xml) {
  const parsed = parseOpml(xml);

  const found =
    parsed.length > 0
      ? parsed.map((entry) => ({ url: entry.url, title: entry.title || null }))
      : scanOutlines(xml);

  return { entries: found.slice(0, PREVIEW_LIMIT), total: found.length };
}

/**
 * @param {string} xml
 * @returns {Array<{ url: string, title: string|null }>}
 */
function scanOutlines(xml) {
  const seen = new Set();
  const found = [];

  for (const match of xml.matchAll(/<outline\b[^>]*>/gi)) {
    const tag = match[0];
    const url = attr(tag, 'xmlUrl');
    if (!url) continue;

    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    found.push({ url, title: attr(tag, 'text') ?? attr(tag, 'title') });
  }

  return found;
}

/**
 * @param {string} tag
 * @param {string} name
 * @returns {string|null}
 */
function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return match ? decode(match[1]) : null;
}

/**
 * @param {string} xml
 * @param {string} name
 * @returns {string|null}
 */
function tagText(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
  return match ? decode(match[1].trim()) || null : null;
}

/**
 * The five entities XML defines. Nothing else, because this is naming a file on
 * a status page, not rendering a document.
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
