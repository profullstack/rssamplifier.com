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
 * Shorter, and spent on a guess: the https twin of an http address, tried
 * before the address itself. A host that has TLS answers this immediately, and
 * one that does not usually refuses the connection outright rather than hanging
 * — so the cost of asking is near zero in both of the common cases, and this
 * clock only bounds the third, where a firewall drops the packet in silence.
 */
const SECURE_TIMEOUT_MS = 2500;

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

const USER_AGENT = 'rssamplifier.com reader (+https://rssamp.com/about)';

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
  const policies = readFrameAncestors(csp);

  if (policies.length > 0) {
    // Every policy is enforced independently, so one that refuses refuses,
    // however permissive the others are.
    return policies.every((sources) => sources.some((source) => sourceAllows(source, origin)))
      ? { frameable: true, reason: 'csp-allows' }
      : { frameable: false, reason: 'csp-frame-ancestors' };
  }

  const xfo = String(headers.xFrameOptions ?? '')
    .trim()
    .toLowerCase();

  if (!xfo) return { frameable: true, reason: 'no-policy' };

  // Read as a list, because it arrives as one. A server with the header set in
  // two places sends it twice — open.audio answers with both DENY and
  // SAMEORIGIN — and fetch joins duplicates into "deny, sameorigin". Compared
  // whole against each keyword that matched none of them, so a page refusing
  // framing twice over was called an unrecognised policy and framed anyway.
  // Browsers resolve a conflict by blocking; so does this.
  const tokens = xfo
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.includes('deny')) return { frameable: false, reason: 'x-frame-options-deny' };
  // SAMEORIGIN blocks us by definition: we are never the same origin as the blog.
  if (tokens.includes('sameorigin')) {
    return { frameable: false, reason: 'x-frame-options-sameorigin' };
  }
  // ALLOW-FROM is obsolete and unsupported by current browsers, which fall back
  // to blocking. Treat it as a refusal rather than guessing.
  if (tokens.some((token) => token.startsWith('allow-from'))) {
    return { frameable: false, reason: 'x-frame-options-allow-from' };
  }

  return { frameable: true, reason: 'unrecognised-policy' };
}

/**
 * Pull every frame-ancestors source list out of a CSP header.
 *
 * A comma separates whole policies, and a header set in two places arrives as
 * both joined by one — the same duplication that defeats X-Frame-Options above.
 * Split on it first, or a second policy's sources are read as extra sources of
 * the first, and `frame-ancestors 'none', frame-ancestors *` reads as allowing
 * anyone.
 *
 * @param {string} csp
 * @returns {string[][]} one source list per policy that declares the directive
 */
function readFrameAncestors(csp) {
  const found = [];

  for (const policy of csp.split(',')) {
    for (const directive of policy.split(';')) {
      const parts = directive.trim().split(/\s+/);
      const name = (parts[0] ?? '').toLowerCase();
      if (name === 'frame-ancestors') {
        found.push(parts.slice(1).map((p) => p.toLowerCase()));
        break;
      }
    }
  }

  return found;
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

  const normalized = normalizeUrl(url);
  if (!normalized) return no('invalid-url');

  const target = new URL(normalized);
  if (!(await isPublicHost(target.hostname))) return no('blocked-host');

  // An http:// address is one the reader cannot show even when the fetch
  // succeeds. We are served over https, so the browser treats an http frame as
  // blockable mixed content and refuses it before our own CSP is consulted —
  // and `frame-src`/`media-src` list only https anyway. The page went blank
  // with no way to tell the reader why: the fetch here worked fine, and the
  // refusal happened later, in a browser we hear nothing back from.
  //
  // So the scheme is upgraded where the publisher supports it, which by now is
  // most of them: a feed that still prints http:// links is usually a feed
  // whose template was written once and never revisited, in front of a server
  // that has had TLS for years. Asked as a plain probe on a short clock, and
  // only for the addresses that need it, so a genuinely http-only host pays one
  // fast timeout and then gets exactly what it got before.
  if (target.protocol === 'http:') {
    const secure = await attempt(secureTwin(target), {
      origin,
      wantHtml,
      timeout: SECURE_TIMEOUT_MS,
    });
    if (secure.status > 0 && secure.status < 400) return secure;
  }

  return attempt(normalized, { origin, wantHtml, timeout: TIMEOUT_MS });
}

/**
 * The same address over TLS.
 *
 * Host, port and path are left alone — only the scheme moves — so this is the
 * same resource on the same server, not a guess at where it might have moved.
 * A URL that names port 80 explicitly is left as it is: that is a server
 * saying which socket it serves from, and 443 is not it.
 *
 * @param {URL} target
 * @returns {string}
 */
function secureTwin(target) {
  const secure = new URL(target.href);
  secure.protocol = 'https:';
  return secure.href;
}

/**
 * A probe that failed, in the shape a caller can read without checking first.
 *
 * @param {string} reason
 * @returns {{ frameable: boolean, reason: string, html: string|null, url: string|null, status: number, contentType: string }}
 */
function no(reason) {
  return { frameable: false, reason, html: null, url: null, status: 0, contentType: '' };
}

/**
 * One fetch of one address, and the verdict that comes off it.
 *
 * Split out of `probePage` so the https-first attempt above is the same code
 * as the attempt it falls back to — the two differ only in how long they are
 * given to answer.
 *
 * @param {string} normalized
 * @param {{ origin: string, wantHtml: boolean|'always', timeout: number }} options
 * @returns {Promise<{ frameable: boolean, reason: string, html: string|null, url: string|null, status: number, contentType: string }>}
 */
async function attempt(normalized, { origin, wantHtml, timeout }) {
  const controller = new AbortController();
  // Headers decide the verdict and arrive quickly; a body worth reading is
  // allowed longer, because it is now the page rather than a detail of it.
  let timer = setTimeout(() => controller.abort(), timeout);

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
