import dns from 'node:dns/promises';
import net from 'node:net';

import { looksLikeFeed, normalizeUrl, findFeedLinks, guessFeedUrls } from './discover.js';
import { parseFeed } from './parse.js';

const USER_AGENT =
  'RSSAmplifierBot/1.0 (+https://rssamplifier.com/about; feed directory indexer)';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — generous for a feed, bounded for us
const TIMEOUT_MS = 15_000;

/**
 * Private, loopback, link-local and carrier-grade-NAT ranges.
 *
 * Anyone can submit a URL and we fetch it from inside Railway, so without this
 * the submit endpoint is a server-side request forgery primitive: an attacker
 * could point it at internal services or at the cloud metadata endpoint
 * (169.254.169.254) and read back credentials in the error message.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fe80')) return true; // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique-local
    // IPv4-mapped (::ffff:10.0.0.1) must be checked as IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }

  return true; // unparseable — refuse
}

/**
 * Resolve a hostname and refuse if any address is internal.
 *
 * Every resolved address is checked, not just the first: a hostname with both a
 * public and a private A record would otherwise slip through.
 *
 * @param {string} hostname
 * @returns {Promise<boolean>} true when safe to fetch
 */
export async function isPublicHost(hostname) {
  if (net.isIP(hostname)) return !isBlockedAddress(hostname);

  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.internal')) {
    return false;
  }

  try {
    const addrs = await dns.lookup(hostname, { all: true });
    if (addrs.length === 0) return false;
    return addrs.every((a) => !isBlockedAddress(a.address));
  } catch {
    return false;
  }
}

/**
 * Fetch a URL with the guards this service needs: SSRF check, timeout, and a
 * response size cap so a hostile endpoint can't stream us out of memory.
 *
 * @param {string} url
 * @returns {Promise<{ ok: boolean, status: number, contentType: string, body: string, url: string, error?: string }>}
 */
export async function safeFetch(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    return { ok: false, status: 0, contentType: '', body: '', url, error: 'invalid-url' };
  }

  const target = new URL(normalized);
  if (!(await isPublicHost(target.hostname))) {
    return {
      ok: false,
      status: 0,
      contentType: '',
      body: '',
      url: normalized,
      error: 'blocked-host',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(normalized, {
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });

    // A redirect can land somewhere internal even when the origin was public.
    const finalHost = new URL(res.url).hostname;
    if (finalHost !== target.hostname && !(await isPublicHost(finalHost))) {
      return {
        ok: false,
        status: res.status,
        contentType: '',
        body: '',
        url: res.url,
        error: 'blocked-redirect',
      };
    }

    const body = await readCapped(res);

    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body,
      url: res.url,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      contentType: '',
      body: '',
      url: normalized,
      error: err?.name === 'AbortError' ? 'timeout' : 'fetch-failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response body, stopping at MAX_BYTES.
 *
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function readCapped(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(
    chunks.length === 1 ? chunks[0] : concat(chunks, Math.min(total, MAX_BYTES)),
  );
}

/**
 * @param {Uint8Array[]} chunks
 * @param {number} size
 * @returns {Uint8Array}
 */
function concat(chunks, size) {
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    if (off + c.length > size) {
      out.set(c.subarray(0, size - off), off);
      break;
    }
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Resolve whatever a user submitted into a parsed feed.
 *
 * Tries, in order: the URL itself as a feed, any feed advertised by the page's
 * <link rel="alternate"> tags, then a short list of conventional paths. Stops at
 * the first thing that parses.
 *
 * @param {string} input a site URL or a feed URL
 * @returns {Promise<{ ok: true, feedUrl: string, feed: object } | { ok: false, error: string }>}
 */
export async function resolveFeed(input) {
  const start = normalizeUrl(input);
  if (!start) return { ok: false, error: 'invalid-url' };

  const first = await safeFetch(start);
  if (!first.ok) return { ok: false, error: first.error ?? `http-${first.status}` };

  if (looksLikeFeed(first.contentType, first.body)) {
    const feed = parseFeed(first.body, first.url);
    if (feed) return { ok: true, feedUrl: first.url, feed };
  }

  const candidates = [...findFeedLinks(first.body, first.url), ...guessFeedUrls(first.url)];

  const seen = new Set([first.url]);
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const res = await safeFetch(candidate);
    if (!res.ok) continue;
    if (!looksLikeFeed(res.contentType, res.body)) continue;

    const feed = parseFeed(res.body, res.url);
    if (feed && feed.items.length > 0) return { ok: true, feedUrl: res.url, feed };
  }

  return { ok: false, error: 'no-feed-found' };
}
