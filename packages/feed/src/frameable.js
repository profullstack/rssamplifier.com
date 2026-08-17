import { normalizeUrl } from './discover.js';
import { isPublicHost } from './fetch.js';

/**
 * Whether a page will load inside our reader's iframe.
 *
 * A browser gives the embedding page no way to find this out: a blocked frame
 * looks exactly like one that is still loading, and the error lands in the
 * console of a document we cannot read. So the check happens on the server,
 * before the iframe is rendered, and a page that refuses framing gets an honest
 * "open it directly" card instead of a blank rectangle the reader would sit in
 * front of forever.
 */

/** Headers-only probes are quick; a slow one is not worth delaying the page for. */
const TIMEOUT_MS = 5000;

/**
 * Longer, and only spent once the headers said the page cannot be framed — at
 * which point the body is the article the reader came for, not a detail.
 */
const BODY_TIMEOUT_MS = 10_000;

/**
 * Byte ceiling on a body worth reading. Mirrors extract.js, which explains why
 * it is this generous: an article page's own markup is a small fraction of
 * what a commercial site sends, and cutting early cuts the article.
 */
const MAX_HTML_BYTES = 2 * 1024 * 1024;

const USER_AGENT = 'rssamplifier.com reader (+https://rssamplifier.com)';

/**
 * Decide framing from the two headers that govern it.
 *
 * Split out from the fetch so the parsing — which is where the subtleties are —
 * is testable without a network.
 *
 * `frame-ancestors` supersedes X-Frame-Options wherever both appear, which is
 * why it is consulted first.
 *
 * @param {{ xFrameOptions?: string|null, contentSecurityPolicy?: string|null }} headers
 * @param {string} [origin] the origin doing the embedding
 * @returns {{ frameable: boolean, reason: string }}
 */
export function framingVerdict(headers, origin = 'https://rssamplifier.com') {
  const csp = String(headers.contentSecurityPolicy ?? '');
  const ancestors = readFrameAncestors(csp);

  if (ancestors !== null) {
    return ancestors.some((source) => sourceAllows(source, origin))
      ? { frameable: true, reason: 'csp-allows' }
      : { frameable: false, reason: 'csp-frame-ancestors' };
  }

  const xfo = String(headers.xFrameOptions ?? '')
    .trim()
    .toLowerCase();

  if (!xfo) return { frameable: true, reason: 'no-policy' };
  if (xfo === 'deny') return { frameable: false, reason: 'x-frame-options-deny' };
  // SAMEORIGIN blocks us by definition: we are never the same origin as the blog.
  if (xfo === 'sameorigin') return { frameable: false, reason: 'x-frame-options-sameorigin' };
  // ALLOW-FROM is obsolete and unsupported by current browsers, which fall back
  // to blocking. Treat it as a refusal rather than guessing.
  if (xfo.startsWith('allow-from')) return { frameable: false, reason: 'x-frame-options-allow-from' };

  return { frameable: true, reason: 'unrecognised-policy' };
}

/**
 * Pull the frame-ancestors source list out of a CSP header.
 *
 * @param {string} csp
 * @returns {string[]|null} sources, or null when the directive is absent
 */
function readFrameAncestors(csp) {
  for (const directive of csp.split(';')) {
    const parts = directive.trim().split(/\s+/);
    const name = (parts[0] ?? '').toLowerCase();
    if (name === 'frame-ancestors') return parts.slice(1).map((p) => p.toLowerCase());
  }
  return null;
}

/**
 * Does one frame-ancestors source permit our origin?
 *
 * @param {string} source
 * @param {string} origin
 * @returns {boolean}
 */
function sourceAllows(source, origin) {
  if (source === "'none'" || source === "'self'") return false;
  if (source === '*') return true;
  if (source === 'https:' || source === 'http:') return origin.startsWith(source);

  const host = origin.replace(/^https?:\/\//, '');
  const bare = source.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  if (bare === host) return true;
  // A leading wildcard covers subdomains: *.example.com matches a.example.com.
  if (bare.startsWith('*.')) return host.endsWith(bare.slice(1));

  return false;
}

/**
 * Probe a URL and decide whether the reader can frame it.
 *
 * Failures are answered with `frameable: false` rather than an exception: the
 * reader always has a usable fallback, so a probe that times out should degrade
 * to "open it directly" instead of breaking the page.
 *
 * @param {string} url
 * @param {string} [origin]
 * @returns {Promise<{ frameable: boolean, reason: string }>}
 */
export async function isFrameable(url, origin = 'https://rssamplifier.com') {
  const { frameable, reason } = await probePage(url, { origin });
  return { frameable, reason };
}

/**
 * Probe a URL, and keep the page when the answer is no.
 *
 * The probe already fetches the page with GET — HEAD is answered with 405 by
 * too much of the web to be worth trying — and then throws the body away. When
 * the verdict is "cannot be framed" that body is the only copy of an article
 * the reader is about to tell somebody they cannot have, so it is read instead
 * of dropped. A refusal costs no extra request: it is the same response, read
 * to the end rather than cancelled.
 *
 * A page that *can* be framed still has its body cancelled by default. Nothing
 * on the page rendering path wants it, and downloading a megabyte of
 * somebody's homepage to discard it is a cost paid on the reader's time.
 *
 * `wantHtml: 'always'` is the exception, and it has one caller: the frame
 * itself. Serving a framed page from our origin so its own links keep working
 * means reading the body of a page the verdict said yes to — see reframe.js
 * for why that is worth a download.
 *
 * @param {string} url
 * @param {{ origin?: string, wantHtml?: boolean|'always' }} [options]
 * @returns {Promise<{
 *   frameable: boolean,
 *   reason: string,
 *   html: string|null,
 *   url: string|null,
 *   status: number,
 *   contentType: string,
 * }>}
 */
export async function probePage(url, options = {}) {
  const { origin = 'https://rssamplifier.com', wantHtml = true } = options;
  const no = (reason) => ({
    frameable: false,
    reason,
    html: null,
    url: null,
    status: 0,
    contentType: '',
  });

  const normalized = normalizeUrl(url);
  if (!normalized) return no('invalid-url');

  const target = new URL(normalized);
  if (!(await isPublicHost(target.hostname))) return no('blocked-host');

  const controller = new AbortController();
  // Headers decide the verdict and arrive quickly; a body worth reading is
  // allowed longer, because it is now the page rather than a detail of it.
  let timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(normalized, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });

    const verdict = framingVerdict(
      {
        xFrameOptions: res.headers.get('x-frame-options'),
        contentSecurityPolicy: res.headers.get('content-security-policy'),
      },
      origin,
    );

    // Redirects are followed, so what came back may not be what was asked for,
    // and relative URLs inside it resolve against where it landed.
    const finalUrl = res.url || normalized;
    const contentType = String(res.headers.get('content-type') ?? '');

    const wanted = wantHtml === 'always' ? true : Boolean(wantHtml) && !verdict.frameable;
    const readable = wanted && res.ok && contentType.toLowerCase().includes('html');

    if (!readable) {
      await res.body?.cancel();
      // The status and the type still matter to a caller that asked for the
      // body: "we did not read this" and "there was nothing here to read" are
      // different answers, and only one of them is a failure.
      if (!res.ok) return { ...no(`http-${res.status}`), status: res.status, contentType };
      return { ...verdict, html: null, url: finalUrl, status: res.status, contentType };
    }

    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), BODY_TIMEOUT_MS);

    const html = await readCapped(res, MAX_HTML_BYTES);
    return { ...verdict, html, url: finalUrl, status: res.status, contentType };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return no(aborted ? 'timeout' : 'fetch-failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response body, stopping at a byte budget.
 *
 * `res.text()` has no ceiling, and a reader who opens a post should not be
 * waiting on a page that turned out to be a 40MB single-page app. Cutting the
 * HTML mid-document is fine here: the parser is forgiving and the article is
 * near the top of anything worth reading.
 *
 * @param {Response} res
 * @param {number} limit bytes
 * @returns {Promise<string>}
 */
async function readCapped(res, limit) {
  const body = res.body;
  if (!body) return '';

  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let out = '';
  let seen = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (seen >= limit) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return out + decoder.decode();
}
