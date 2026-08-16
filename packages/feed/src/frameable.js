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
  const normalized = normalizeUrl(url);
  if (!normalized) return { frameable: false, reason: 'invalid-url' };

  const target = new URL(normalized);
  if (!(await isPublicHost(target.hostname))) {
    return { frameable: false, reason: 'blocked-host' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // GET, not HEAD: a fair number of sites answer HEAD with 405 or omit the
    // very headers being probed for. The body is abandoned as soon as the
    // headers are in.
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

    await res.body?.cancel();

    if (!res.ok) return { frameable: false, reason: `http-${res.status}` };
    return verdict;
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return { frameable: false, reason: aborted ? 'timeout' : 'fetch-failed' };
  } finally {
    clearTimeout(timer);
  }
}
