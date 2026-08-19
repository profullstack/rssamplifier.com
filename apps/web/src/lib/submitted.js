import { parseOpml } from '@rssamplifier/feed';

// The same reading of an `<outline>` tag the uploader does in the browser. Two
// copies would be two answers to "what does &amp; mean in an attribute", and
// this page exists to show the submitter what they submitted — disagreeing with
// the thing that imported it is the one way it can be wrong.
import { attrOf, decodeXml, outlineTags } from './opml-scan.js';

/**
 * How much of a submission's input is kept, counted in lines.
 *
 * The submit route stores this much of what was uploaded and no more — a
 * catalogue can be tens of megabytes, and the audit trail exists to identify a
 * submission, not to hold a second copy of it. Exported so the status page can
 * tell "this is all of it" from "this is the first part of it" by the same
 * number the writer used, rather than by a literal that drifts.
 *
 * Lines, not characters, because a line is the unit the submitter works in:
 * the paste box takes one URL per line and an OPML export puts one feed on one
 * line, so a cap counted in lines is a promise about a number of feeds. Counted
 * in characters it was a promise about nothing in particular, and a much
 * tighter one than it read — fifty thousand characters is only a few hundred
 * pasted URLs, so the status page called uploads truncated that were nothing of
 * the sort.
 *
 * Two hundred thousand rather than fifty, because fifty was below the size of
 * the lists people actually bring here: a subscription export of a hundred and
 * ten thousand feeds is an ordinary thing to submit, and being told that only
 * the first fifty thousand lines were kept reads as a cap on the submission
 * itself rather than on the copy of it stored for this page. It never was one —
 * the ceiling on a submission is `MAX_UPLOAD_FEEDS` and it is in the tens of
 * millions — so the number here should be large enough that a real list is
 * recorded whole and the note about truncation is one almost nobody sees.
 */
export const RAW_INPUT_LINE_LIMIT = 200_000;

/**
 * A second cap, on bytes, for the shape the line cap cannot see.
 *
 * A minified OPML is one very long line, and plenty of exporters emit exactly
 * that — for such a file "the first two hundred thousand lines" is the whole
 * document, however many megabytes it runs to, and the cap would quietly do
 * nothing. Sized so it can only ever bite that degenerate case, and belt and
 * braces even then: the endpoint that stores a whole submission refuses a body
 * over `INLINE_UPLOAD_LIMIT` (10 MB) before reading it, so nothing arriving
 * that way can reach this at all. It stands for the writers that do not go
 * through it — the MCP tool, and whatever comes next.
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
 * Whether a stored copy is all of what was uploaded or only the head of it.
 *
 * Inferred from the stored text rather than recorded at write time, so that
 * rows written before the cap moved are still read sensibly. A submission
 * sitting exactly on the limit is reported as truncated, which is the honest
 * answer when the writer cannot tell either, and matches what the character cap
 * did before it.
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
 * line boundary that lands mid-tag as often as not — and a document cut mid-tag
 * is malformed, so the parser returns nothing at all for a file whose first
 * sixty entries are perfectly readable.
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

  for (const tag of outlineTags(xml)) {
    const url = attrOf(tag, 'xmlUrl');
    if (!url) continue;

    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    found.push({ url, title: attrOf(tag, 'text') ?? attrOf(tag, 'title') });
  }

  return found;
}

/**
 * @param {string} xml
 * @param {string} name
 * @returns {string|null}
 */
function tagText(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
  return match ? decodeXml(match[1].trim()) || null : null;
}
