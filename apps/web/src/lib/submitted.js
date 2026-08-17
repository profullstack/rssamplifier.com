import { parseOpml } from '@rssamplifier/feed';

/**
 * How much of a submission's input is kept.
 *
 * The submit route stores this much of what was uploaded and no more — a
 * catalogue can be tens of megabytes, and the audit trail exists to identify a
 * submission, not to hold a second copy of it. Exported so the status page can
 * tell "this is all of it" from "this is the first part of it" by the same
 * number the writer used, rather than by a literal that drifts.
 */
export const RAW_INPUT_LIMIT = 10_000;

/** Entries listed on the status page before it starts summarising. */
export const PREVIEW_LIMIT = 30;

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
  const truncated = raw.length >= RAW_INPUT_LIMIT;

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
 * entities. It cannot help here in the common case, though: what is stored is
 * the first ten thousand characters of an upload, which for any real catalogue
 * ends mid-tag, and a document cut mid-tag is malformed — the parser returns
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
