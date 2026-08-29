import dns from 'node:dns/promises';
import net from 'node:net';

import { looksLikeFeed, normalizeUrl, findFeedLinks, guessFeedUrls } from './discover.js';
import { parseFeed } from './parse.js';
import { findPlaylistLinks } from './playlist.js';

// The short domain, which 302s to the same page with the path kept
// (rssamp.com/about -> rssamplifier.com/about). A user-agent string is read in
// a server log, on a narrow line, next to a hundred others, so the shorter it
// is the likelier somebody actually follows it.
//
// The product token stays `RSSAmplifierBot`. That is the half webmasters write
// into robots.txt, and renaming it would silently void every rule anybody has
// already written against us -- the URL is the part that is safe to change.
const USER_AGENT = 'RSSAmplifierBot/1.0 (+https://rssamp.com/about; feed directory indexer)';

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
 * Optionally conditional. Given the validators a previous fetch returned, this
 * sends them back and a well-behaved server answers `304 Not Modified` with no
 * body at all. That is worth having twice over. It is the polite thing to do
 * when reading two thousand other people's documents an hour, and — the larger
 * reason here — a 304 is the *publisher* stating that nothing has changed, which
 * is better evidence for scheduling than anything we can infer from a document,
 * and it arrives without one being parsed.
 *
 * A 304 comes back as `ok: false, notModified: true` rather than as an error:
 * the request succeeded and the answer is a fact, but the body is empty and no
 * caller expecting `body` should treat it as a document.
 *
 * The validators are echoed back on every answer, including on a 304 — servers
 * are permitted to send a fresh `ETag` there and a caller that dropped it would
 * keep revalidating against a stale one for ever.
 *
 * @param {string} url
 * @param {{ etag?: string|null, lastModified?: string|null,
 *   headers?: Record<string, string> }} [conditional]
 * @returns {Promise<{ ok: boolean, status: number, contentType: string, body: string, url: string, notModified?: boolean, etag?: string|null, lastModified?: string|null, retryAfter?: number|null, error?: string }>}
 */
export async function safeFetch(url, conditional = {}) {
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
    /** @type {Record<string, string>} */
    const headers = { 'user-agent': USER_AGENT, accept: '*/*' };
    if (conditional?.etag) headers['if-none-match'] = String(conditional.etag);
    if (conditional?.lastModified) headers['if-modified-since'] = String(conditional.lastModified);

    // Caller-supplied headers, for the JSON APIs the author enrichment asks
    // about a person. They go through this function rather than around it so
    // an API host is still checked against the private-address guard and still
    // bounded by the same timeout -- a profile URL is built from a hostname we
    // read out of somebody else's feed, so it is exactly as untrusted as a
    // page URL. The user-agent stays ours and cannot be overridden.
    for (const [key, value] of Object.entries(conditional?.headers ?? {})) {
      const name = String(key).toLowerCase();
      if (name === 'user-agent') continue;
      headers[name] = String(value);
    }

    const res = await fetch(normalized, {
      headers,
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

    // Kept from the previous fetch when this answer omits them, which is the
    // common case on a 304: RFC 9110 lets a server send the validators again
    // but does not require it, and forgetting the ones we hold would turn every
    // subsequent request back into an unconditional one.
    const etag = res.headers.get('etag') ?? conditional?.etag ?? null;
    const lastModified = res.headers.get('last-modified') ?? conditional?.lastModified ?? null;

    // Before the body is read, because there is not one. Returning early also
    // keeps `ok` honest: a 304 is a successful request whose answer is "no
    // document", and every caller reading `body` must fall through to
    // `notModified` rather than parse an empty string.
    if (res.status === 304) {
      return {
        ok: false,
        notModified: true,
        status: 304,
        contentType: '',
        body: '',
        url: res.url,
        etag,
        lastModified,
      };
    }

    const body = await readCapped(res);

    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body,
      url: res.url,
      retryAfter: retryAfterSeconds(res.headers.get('retry-after')),
      etag,
      lastModified,
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
 * Fetch the *start* of a binary file, with the same guards as safeFetch.
 *
 * For asking how big an image is without downloading it. A `Range` header keeps
 * a well-behaved server from sending more than the header bytes, and the read
 * loop enforces the cap regardless — plenty of hosts ignore Range, and one that
 * answers a ranged request with a 40MB body must not be able to stream us out of
 * memory just because it declined to cooperate.
 *
 * Separate from `safeFetch` rather than a flag on it, because that function's
 * contract is a decoded string: running an image through a UTF-8 decoder and
 * back is both lossy and pointless.
 *
 * @param {string} url
 * @param {number} [maxBytes]
 * @returns {Promise<{ ok: boolean, status: number, contentType: string, bytes: Uint8Array, url: string, error?: string }>}
 */
export async function safeFetchBytes(url, maxBytes = 64 * 1024) {
  const empty = new Uint8Array(0);
  const normalized = normalizeUrl(url);
  if (!normalized) {
    return { ok: false, status: 0, contentType: '', bytes: empty, url, error: 'invalid-url' };
  }

  const target = new URL(normalized);
  if (!(await isPublicHost(target.hostname))) {
    return {
      ok: false,
      status: 0,
      contentType: '',
      bytes: empty,
      url: normalized,
      error: 'blocked-host',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(normalized, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'image/*,*/*',
        range: `bytes=0-${maxBytes - 1}`,
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    const finalHost = new URL(res.url).hostname;
    if (finalHost !== target.hostname && !(await isPublicHost(finalHost))) {
      return {
        ok: false,
        status: res.status,
        contentType: '',
        bytes: empty,
        url: res.url,
        error: 'blocked-redirect',
      };
    }

    // 206 is the cooperative answer and 200 the whole file; both are fine, and
    // 416 means the file is shorter than the range we asked for, which is a
    // refusal to be treated as one.
    const ok = res.status === 200 || res.status === 206;

    return {
      ok,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      bytes: ok ? await readCappedBytes(res, maxBytes) : empty,
      url: res.url,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      contentType: '',
      bytes: empty,
      url: normalized,
      error: err?.name === 'AbortError' ? 'timeout' : 'fetch-failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read at most `limit` bytes of a response, then hang up.
 *
 * @param {Response} res
 * @param {number} limit
 * @returns {Promise<Uint8Array>}
 */
async function readCappedBytes(res, limit) {
  if (!res.body) return new Uint8Array(0);

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;

  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }

  // Cancelled rather than drained: the point of the exercise is not to download
  // the file.
  await reader.cancel().catch(() => {});

  return chunks.length === 1 && chunks[0].length <= limit
    ? chunks[0]
    : concat(chunks, Math.min(total, limit));
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
 * How long a server asked us to wait, in seconds.
 *
 * RFC 9110 allows either a delay in seconds or an HTTP date, and both are seen
 * in the wild. Anything unparseable is null, which the caller reads as "throttled
 * but unsaid" and answers with its own default rather than with zero.
 *
 * Clamped to a day. A server that asks for a month has almost certainly sent us
 * a date we misread, and honouring it literally would retire the feed.
 *
 * @param {string|null} header
 * @returns {number|null}
 */
export function retryAfterSeconds(header) {
  if (!header) return null;

  const seconds = Number(String(header).trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds), 86_400);

  const at = Date.parse(String(header));
  if (!Number.isNaN(at)) return Math.min(Math.max(0, Math.round((at - Date.now()) / 1000)), 86_400);

  return null;
}

/**
 * Resolve whatever a user submitted into a parsed feed.
 *
 * Tries, in order: the URL itself as a feed, any feed advertised by the page's
 * <link rel="alternate"> tags, then a short list of conventional paths. Stops at
 * the first thing that parses.
 *
 * Given the validators from a previous crawl it asks conditionally, and a `304`
 * short-circuits everything below: the answer is `notModified`, with no feed and
 * no discovery. The short-circuit is the whole point rather than a detail — a
 * 304 arriving here would otherwise carry an empty body, fail `looksLikeFeed`,
 * and send the resolver off to spend nine speculative requests hunting for a
 * feed at a URL that had just told us it still had one.
 *
 * Validators are only ever sent for `input` itself, never for a discovered
 * candidate, since they describe one document and a candidate is a different
 * one. In practice a re-crawl passes the feed URL it already resolved, so the
 * conditional request is the one that matters and discovery does not run at all.
 *
 * @param {string} input a site URL or a feed URL
 * @param {{ etag?: string|null, lastModified?: string|null }} [conditional]
 * @returns {Promise<{ ok: true, feedUrl: string, feed: object, etag?: string|null, lastModified?: string|null } | { ok: false, notModified?: boolean, error?: string }>}
 */
export async function resolveFeed(input, conditional = {}) {
  const start = normalizeUrl(input);
  if (!start) return { ok: false, error: 'invalid-url' };

  const first = await safeFetch(start, conditional);
  if (first.notModified) {
    return { ok: false, notModified: true, etag: first.etag, lastModified: first.lastModified };
  }
  // A throttle is not a broken feed, and the difference has to survive this
  // return or the crawler cannot tell them apart. 429 is the explicit form; 503
  // with a Retry-After is the same statement from a server that is briefly
  // unwilling rather than permanently unable. Both mean "come back later", which
  // is a schedule instruction, not evidence about the publisher.
  if (!first.ok) {
    const throttled = first.status === 429 || (first.status === 503 && first.retryAfter != null);
    return {
      ok: false,
      error: first.error ?? `http-${first.status}`,
      ...(throttled ? { throttled: true, retryAfter: first.retryAfter ?? null } : {}),
    };
  }

  if (looksLikeFeed(first.contentType, first.body, first.url)) {
    const feed = parseFeed(first.body, first.url);
    if (feed) {
      return {
        ok: true,
        feedUrl: first.url,
        feed,
        etag: first.etag ?? null,
        lastModified: first.lastModified ?? null,
      };
    }
  }

  // Playlists come last, after every feed candidate has failed. A site with
  // both is a site that publishes a feed, and the m3u next to it is one album
  // off it — indexing the album in place of the blog would be the wrong answer
  // to "add this site".
  const candidates = [
    ...findFeedLinks(first.body, first.url),
    ...guessFeedUrls(first.url),
    ...findPlaylistLinks(first.body, first.url),
  ];

  const seen = new Set([first.url]);
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const res = await safeFetch(candidate);
    if (!res.ok) continue;
    if (!looksLikeFeed(res.contentType, res.body, res.url)) continue;

    const feed = parseFeed(res.body, res.url);
    if (feed && feed.items.length > 0) {
      return {
        ok: true,
        feedUrl: res.url,
        feed,
        etag: res.etag ?? null,
        lastModified: res.lastModified ?? null,
      };
    }
  }

  return { ok: false, error: 'no-feed-found' };
}
