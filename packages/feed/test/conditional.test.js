import assert from 'node:assert/strict';
import { test } from 'node:test';

import { safeFetch, resolveFeed } from '../src/fetch.js';

/**
 * A public IP rather than a hostname, so the SSRF guard answers from `net.isIP`
 * and nothing in here depends on DNS.
 */
const HOST = '93.184.216.34';
const FEED_URL = `https://${HOST}/feed.xml`;

const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>A Blog</title>
  <item><title>One</title><link>https://example.com/1</link><guid>1</guid></item>
</channel></rss>`;

/**
 * Stand in for the network, recording the headers each request carried.
 *
 * @param {(url: string, headers: Record<string, string>) => { status?: number, type?: string, body?: string, headers?: Record<string, string> }} answer
 */
function network(answer) {
  const saved = globalThis.fetch;
  const asked = [];

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const headers = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
    asked.push({ url: href, headers });

    const reply = answer(href, headers);
    const status = reply.status ?? 200;
    const res = new Response(status === 304 ? null : (reply.body ?? ''), {
      status,
      headers: { 'content-type': reply.type ?? 'application/xml', ...(reply.headers ?? {}) },
    });
    // A hand-built Response has an empty `url`, and safeFetch reads it to check
    // that a redirect did not land somewhere internal. Without this the guard
    // throws on `new URL('')` and every request in here fails as `fetch-failed`.
    Object.defineProperty(res, 'url', { value: href });
    return res;
  };

  return { asked, restore: () => (globalThis.fetch = saved) };
}

test('validators from the last crawl are sent back, and 304 is not an error', async () => {
  // The crawler reads roughly two thousand of other people's documents an hour.
  // A conditional request turns most of those into a header exchange, and -- the
  // reason it is here -- a 304 is the publisher stating that nothing changed,
  // which is better evidence for scheduling than anything inferred from a
  // document we had to download and parse to inspect.
  const net = network((_url, headers) =>
    headers['if-none-match'] === 'W/"abc"' ? { status: 304 } : { status: 200, body: FEED },
  );

  try {
    const res = await safeFetch(FEED_URL, { etag: 'W/"abc"', lastModified: 'Mon, 18 Aug 2026 09:00:00 GMT' });

    assert.equal(net.asked[0].headers['if-none-match'], 'W/"abc"');
    assert.equal(net.asked[0].headers['if-modified-since'], 'Mon, 18 Aug 2026 09:00:00 GMT');
    assert.equal(res.status, 304);
    assert.equal(res.notModified, true);
    assert.equal(res.ok, false, 'a 304 carries no document, so no caller may read body');
    assert.equal(res.body, '');
  } finally {
    net.restore();
  }
});

test('a 304 that repeats no validators keeps the ones we already held', async () => {
  // RFC 9110 permits a server to send the validators again on a 304 and does not
  // require it. Forgetting the ones in hand would make every request after the
  // first unconditional -- the bug would be invisible, because everything would
  // still work, just at full price for ever.
  const net = network(() => ({ status: 304 }));

  try {
    const res = await safeFetch(FEED_URL, { etag: 'W/"abc"', lastModified: 'Mon, 18 Aug 2026 09:00:00 GMT' });
    assert.equal(res.etag, 'W/"abc"');
    assert.equal(res.lastModified, 'Mon, 18 Aug 2026 09:00:00 GMT');
  } finally {
    net.restore();
  }
});

test('a fresh answer hands back the validators to store', async () => {
  const net = network(() => ({
    status: 200,
    body: FEED,
    headers: { etag: 'W/"def"', 'last-modified': 'Tue, 19 Aug 2026 10:00:00 GMT' },
  }));

  try {
    const res = await resolveFeed(FEED_URL);
    assert.equal(res.ok, true);
    assert.equal(res.etag, 'W/"def"');
    assert.equal(res.lastModified, 'Tue, 19 Aug 2026 10:00:00 GMT');
  } finally {
    net.restore();
  }
});

test('a 304 stops the resolver dead rather than sending it hunting', async () => {
  // The failure this prevents is expensive and silent. A 304 carries an empty
  // body, which fails `looksLikeFeed`, which sends the resolver off through the
  // <link> tags and then the guessed paths -- nine speculative requests to a
  // server that had just answered "still the same" in one.
  const net = network(() => ({ status: 304 }));

  try {
    const res = await resolveFeed(FEED_URL, { etag: 'W/"abc"' });

    assert.equal(res.ok, false);
    assert.equal(res.notModified, true);
    assert.equal(net.asked.length, 1, `304 cost ${net.asked.length} requests, not 1`);
  } finally {
    net.restore();
  }
});

test('an unconditional call is exactly what it always was', async () => {
  // Submission resolves feeds too, and has no validators to send. It must not
  // acquire a conditional header from a default.
  const net = network(() => ({ status: 200, body: FEED }));

  try {
    const res = await resolveFeed(FEED_URL);

    assert.equal(res.ok, true);
    assert.equal('if-none-match' in net.asked[0].headers, false);
    assert.equal('if-modified-since' in net.asked[0].headers, false);
  } finally {
    net.restore();
  }
});
