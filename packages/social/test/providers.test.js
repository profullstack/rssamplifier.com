import assert from 'node:assert/strict';
import { test } from 'node:test';

import { XRegistry } from '../src/x/registry.js';
import { XSessionPool, sessionsFromEnv } from '../src/x/sessions.js';
import { XRateLimited, XAuthFailed, XUnavailable, XNoSuchSource, classifyResponse } from '../src/x/errors.js';
import { postsFromRss } from '../src/x/providers/fromRss.js';
import { rsshubProvider } from '../src/x/providers/rsshub.js';
import { teapotProvider } from '../src/x/providers/teapot.js';
import { XBudget } from '../src/x/providers/official.js';
import { fetchXSource } from '../src/x/fetch.js';

/*
 * §10, §15 and §16: which provider answers, what a failure means, and what
 * neither of them is allowed to do to a source's health.
 */

/** A provider that does whatever the script says. */
function fake(name, script) {
  let call = 0;
  return {
    name,
    calls: () => call,
    configured: () => true,
    healthCheck: async () => true,
    async fetch() {
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      if (step instanceof Error) throw step;
      return { posts: step };
    },
  };
}

const REQUEST = { mode: 'user', username: 'OpenAI' };

test('the primary answers when it can, and nothing else is asked', async () => {
  const primary = fake('rsshub', [[{ id: '1' }]]);
  const fallback = fake('teapot', [[{ id: '2' }]]);

  const registry = new XRegistry({
    env: { X_PRIMARY_PROVIDER: 'rsshub', X_FALLBACK_PROVIDERS: 'teapot' },
    providers: { rsshub: primary, teapot: fallback },
  });

  const result = await registry.fetch(REQUEST);
  assert.equal(result.provider, 'rsshub');
  assert.equal(fallback.calls(), 0);
});

test('a failed primary fails over, and the caller cannot tell (AC-6)', async () => {
  const primary = fake('rsshub', [new XUnavailable('down')]);
  const fallback = fake('teapot', [[{ id: '2' }]]);

  const registry = new XRegistry({
    env: { X_PRIMARY_PROVIDER: 'rsshub', X_FALLBACK_PROVIDERS: 'teapot' },
    providers: { rsshub: primary, teapot: fallback },
  });

  const result = await registry.fetch(REQUEST);
  assert.equal(result.posts.length, 1);
  assert.equal(fallback.calls(), 1);
});

test('three failures in a row put a provider aside, and a success brings it back', async () => {
  let now = 0;
  const primary = fake('rsshub', [
    new XUnavailable('a'),
    new XUnavailable('b'),
    new XUnavailable('c'),
    [{ id: '9' }],
  ]);
  const fallback = fake('teapot', [[{ id: '2' }]]);

  const registry = new XRegistry({
    env: { X_PRIMARY_PROVIDER: 'rsshub', X_FALLBACK_PROVIDERS: 'teapot' },
    providers: { rsshub: primary, teapot: fallback },
    now: () => now,
  });

  for (let i = 0; i < 3; i += 1) await registry.fetch(REQUEST);
  assert.equal(primary.calls(), 3);

  // In cooldown: the fourth request does not even try it.
  await registry.fetch(REQUEST);
  assert.equal(primary.calls(), 3);
  assert.equal(registry.describe()[0].status, 'cooldown');

  // Once the cooldown lapses it is tried again, and one success clears it.
  now += 60_001;
  await registry.fetch(REQUEST);
  assert.equal(primary.calls(), 4);
  assert.equal(registry.describe()[0].status, 'healthy');
  assert.equal(registry.describe()[0].consecutiveFailures, 0);
});

test('a missing account stops the stack rather than asking three providers', async () => {
  const primary = fake('rsshub', [new XNoSuchSource('gone')]);
  const fallback = fake('teapot', [[{ id: '2' }]]);

  const registry = new XRegistry({
    env: { X_PRIMARY_PROVIDER: 'rsshub', X_FALLBACK_PROVIDERS: 'teapot' },
    providers: { rsshub: primary, teapot: fallback },
  });

  await assert.rejects(() => registry.fetch(REQUEST), /gone/);
  assert.equal(fallback.calls(), 0);
});

test('a rate limit fails over without counting against the provider', async () => {
  const primary = fake('rsshub', [new XRateLimited('429', { retryAfter: 60 })]);
  const fallback = fake('teapot', [[{ id: '2' }]]);

  const registry = new XRegistry({
    env: { X_PRIMARY_PROVIDER: 'rsshub', X_FALLBACK_PROVIDERS: 'teapot' },
    providers: { rsshub: primary, teapot: fallback },
  });

  await registry.fetch(REQUEST);
  assert.equal(registry.describe()[0].consecutiveFailures, 0);
});

test('an unconfigured provider is not in the rotation', () => {
  const registry = new XRegistry({
    env: { X_PRIMARY_PROVIDER: 'rsshub', X_FALLBACK_PROVIDERS: 'teapot,official' },
    providers: {
      rsshub: { ...fake('rsshub', [[]]), configured: () => false },
      teapot: fake('teapot', [[]]),
    },
  });

  assert.deepEqual(
    registry.candidates().map((p) => p.name),
    ['teapot'],
  );
});

test('every provider refusing raises rather than returning an empty feed (§10)', async () => {
  const registry = new XRegistry({
    env: { X_PRIMARY_PROVIDER: 'rsshub', X_FALLBACK_PROVIDERS: 'teapot' },
    providers: {
      rsshub: fake('rsshub', [new XUnavailable('a')]),
      teapot: fake('teapot', [new XUnavailable('b')]),
    },
  });

  await assert.rejects(() => registry.fetch(REQUEST));
});

test('the kill switch takes a provider out entirely (§42)', async () => {
  const registry = new XRegistry({
    env: { X_PRIMARY_PROVIDER: 'rsshub', X_FALLBACK_PROVIDERS: 'teapot' },
    providers: { rsshub: fake('rsshub', [[{ id: '1' }]]), teapot: fake('teapot', [[{ id: '2' }]]) },
  });

  await registry.disable('rsshub');
  const result = await registry.fetch(REQUEST);
  assert.equal(result.provider, 'teapot');
});

/* ------------------------------------------------------------------ sessions */

test('rotation is least-recently-used, so a pool of three is used evenly', () => {
  let now = 0;
  const pool = new XSessionPool(
    [
      { id: 'a', authToken: '1', ct0: '1' },
      { id: 'b', authToken: '2', ct0: '2' },
      { id: 'c', authToken: '3', ct0: '3' },
    ],
    { now: () => (now += 1) },
  );

  const picked = [pool.pick().id, pool.pick().id, pool.pick().id, pool.pick().id];
  assert.deepEqual(picked, ['a', 'b', 'c', 'a']);
});

test('a rate-limited session sits out and comes back on its own (AC-10)', async () => {
  let now = 0;
  const pool = new XSessionPool([{ id: 'a', authToken: '1', ct0: '1' }], {
    now: () => now,
    cooldownSeconds: 900,
  });

  await pool.markFailure('a', new XRateLimited('429', { retryAfter: 60 }));
  assert.equal(pool.pick(), null);

  now += 61_000;
  assert.equal(pool.pick()?.id, 'a');
});

test('an expired session does not come back on a timer', async () => {
  let now = 0;
  const pool = new XSessionPool([{ id: 'a', authToken: '1', ct0: '1' }], { now: () => now });

  await pool.markFailure('a', new XAuthFailed('401'));
  now += 86_400_000;
  assert.equal(pool.pick(), null);

  // Only an operator replacing the credentials brings it back.
  await pool.enable('a');
  assert.equal(pool.pick()?.id, 'a');
});

test('a bad source is not held against the session that asked about it', async () => {
  const pool = new XSessionPool([{ id: 'a', authToken: '1', ct0: '1' }]);

  await pool.markFailure('a', new XNoSuchSource('no such account'));
  assert.equal(pool.pick()?.id, 'a');
  assert.equal(pool.describe()[0].failures, 0);
});

test('nothing renderable about a session is a credential (AC-7)', async () => {
  const pool = new XSessionPool([{ id: 'a', authToken: 'SECRET_TOKEN', ct0: 'SECRET_CT0' }]);
  pool.pick();
  await pool.markFailure('a', new XAuthFailed('auth-failed-401'));

  const rendered = JSON.stringify(pool.describe());
  assert.doesNotMatch(rendered, /SECRET_TOKEN|SECRET_CT0/);
});

test('the structured env form wins, and a mismatched pair is not silently paired wrong', () => {
  assert.deepEqual(
    sessionsFromEnv({ X_SESSIONS: '[{"id":"x-1","authToken":"a","ct0":"b"}]' }),
    [{ id: 'x-1', authToken: 'a', ct0: 'b' }],
  );

  // The positional form: a token with no matching cookie is dropped rather
  // than paired with somebody else's.
  assert.deepEqual(
    sessionsFromEnv({ X_AUTH_TOKENS: 'a,b', X_CT0_TOKENS: 'c' }).map((s) => s.id),
    ['x-session-001'],
  );

  // Malformed JSON does not stop a poller from booting.
  assert.deepEqual(sessionsFromEnv({ X_SESSIONS: '{oops' }), []);
});

/* -------------------------------------------------------------- classification */

test('an upstream reply is classified by what it means, not by its status alone', () => {
  const headers = new Headers({ 'retry-after': '30' });

  assert.ok(classifyResponse({ status: 429, headers }) instanceof XRateLimited);
  assert.equal(classifyResponse({ status: 429, headers }).retryAfter, 30);
  assert.ok(classifyResponse({ status: 401 }) instanceof XAuthFailed);
  assert.ok(classifyResponse({ status: 404 }) instanceof XNoSuchSource);
  assert.ok(classifyResponse({ status: 502 }) instanceof XUnavailable);
  assert.equal(classifyResponse({ status: 200, body: '<rss/>' }), null);

  // A 403 is both "your session died" and "this account is protected"; the body
  // decides, and blaming the session is the cheaper default.
  assert.ok(classifyResponse({ status: 403 }) instanceof XAuthFailed);
  assert.ok(
    classifyResponse({ status: 403, body: 'This is a protected account' }) instanceof XNoSuchSource,
  );

  // A 200 carrying an error page is the quietest failure of the lot.
  assert.ok(classifyResponse({ status: 200, body: 'Rate limit exceeded' }) instanceof XRateLimited);
});

/* ----------------------------------------------------------- the RSS converter */

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>OpenAI Research (@OpenAI) / X</title>
  <link>https://x.com/OpenAI</link>
  <item>
    <title>Hello</title>
    <link>https://x.com/OpenAI/status/1898765432109876543</link>
    <pubDate>Sat, 29 Aug 2026 12:00:00 GMT</pubDate>
    <description><![CDATA[<p>Hello world</p><img src="https://pbs.example/1.jpg">]]></description>
  </item>
  <item>
    <title>A repost</title>
    <link>https://x.com/OpenAI/status/1898765432109876544</link>
    <description><![CDATA[RT @example: their words]]></description>
  </item>
  <item>
    <title>No status link</title>
    <link>https://x.com/OpenAI</link>
    <description>nothing</description>
  </item>
</channel></rss>`;

test('a bridge document becomes posts keyed on X ids, not on the bridge (AC-2)', () => {
  const { posts, displayName } = postsFromRss(RSS, {
    provider: 'rsshub',
    url: 'http://rsshub:1200/twitter/user/OpenAI',
    fallbackHandle: 'OpenAI',
  });

  assert.deepEqual(
    posts.map((p) => p.id),
    ['1898765432109876543', '1898765432109876544'],
  );
  assert.equal(displayName, 'OpenAI Research');

  // A "display name" that is only the handle again adds nothing, so it is
  // dropped rather than rendered as "OpenAI (@OpenAI)".
  assert.equal(
    postsFromRss(RSS.replace('OpenAI Research (@OpenAI) / X', 'OpenAI (@OpenAI) / X'), {
      provider: 'rsshub',
      url: 'http://rsshub:1200/twitter/user/OpenAI',
      fallbackHandle: 'OpenAI',
    }).displayName,
    null,
  );

  // Every link points at x.com, never at the bridge that happened to serve it.
  for (const post of posts) assert.match(post.url, /^https:\/\/x\.com\//);

  assert.equal(posts[0].text, 'Hello world');
  assert.deepEqual(posts[0].media, [{ type: 'image', url: 'https://pbs.example/1.jpg' }]);

  // `RT @x:` is the only repost signal a rendered feed carries.
  assert.equal(posts[1].repostOfId, '1898765432109876544');
  assert.equal(posts[1].text, 'their words');
});

test('an unparseable provider response is an outage, not an empty account', () => {
  assert.throws(
    () => postsFromRss('not xml at all', { provider: 'rsshub', url: 'http://rsshub:1200/x' }),
    /unparseable-response/,
  );
});

/* ------------------------------------------------------------- provider wiring */

test('the two RSS providers refuse to run unconfigured rather than guessing a host', async () => {
  const rsshub = rsshubProvider({});
  const teapot = teapotProvider({});

  assert.equal(rsshub.configured(), false);
  assert.equal(teapot.configured(), false);
  await assert.rejects(() => rsshub.fetch(REQUEST, {}), /RSSHUB_BASE_URL/);
  await assert.rejects(() => teapot.fetch(REQUEST, {}), /TEAPOT_BASE_URL/);
});

test('RSSHub is asked for the right route per mode, and never told which session in a log', async () => {
  const seen = [];
  const provider = rsshubProvider({ RSSHUB_BASE_URL: 'http://rsshub:1200' });

  const doFetch = async (url) => {
    seen.push(url);
    return new Response(RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  };

  await provider.fetch({ mode: 'user', username: 'OpenAI' }, { fetch: doFetch });
  await provider.fetch({ mode: 'media', username: 'OpenAI' }, { fetch: doFetch });
  await provider.fetch({ mode: 'search', query: 'from:OpenAI lang:en' }, { fetch: doFetch });
  await provider.fetch({ mode: 'list', listId: '1234567890' }, { fetch: doFetch });

  assert.match(seen[0], /\/twitter\/user\/OpenAI\?/);
  assert.match(seen[1], /\/twitter\/media\/OpenAI\?/);
  assert.match(seen[2], /\/twitter\/keyword\/from%3AOpenAI%20lang%3Aen\?/);
  assert.match(seen[3], /\/twitter\/list\/1234567890\?/);

  // Replies are asked for only where they are the point.
  assert.match(seen[0], /excludeReplies=1/);
  await provider.fetch({ mode: 'replies', username: 'OpenAI' }, { fetch: doFetch });
  assert.match(seen[4], /excludeReplies=0/);
});

test('Teapot keeps to the Nitter shape', async () => {
  const seen = [];
  const provider = teapotProvider({ TEAPOT_BASE_URL: 'http://teapot:8080' });

  const doFetch = async (url) => {
    seen.push(url);
    return new Response(RSS, { status: 200 });
  };

  await provider.fetch({ mode: 'user', username: 'OpenAI' }, { fetch: doFetch });
  await provider.fetch({ mode: 'replies', username: 'OpenAI' }, { fetch: doFetch });
  await provider.fetch({ mode: 'list', listId: '1234567890' }, { fetch: doFetch });

  assert.match(seen[0], /\/OpenAI\/rss$/);
  assert.match(seen[1], /\/OpenAI\/with_replies\/rss$/);
  assert.match(seen[2], /\/i\/lists\/1234567890\/rss$/);
});

/* -------------------------------------------------------------------- budgets */

test('a spend limit is checked before a request, not after it', () => {
  let now = Date.UTC(2026, 7, 29, 12, 0, 0);
  const budget = new XBudget({ dailyReadBudget: 2, now: () => now });

  assert.equal(budget.available(), true);
  budget.spend();
  budget.spend();
  assert.equal(budget.available(), false);

  // A new UTC day opens it again.
  now += 86_400_000;
  assert.equal(budget.available(), true);
});

/* ------------------------------------------------------------ the crawl seam */

test('a rate limit reaches the crawler as a throttle, never as a source failure', async () => {
  const registry = new XRegistry({
    env: { X_PRIMARY_PROVIDER: 'rsshub', X_FALLBACK_PROVIDERS: '' },
    providers: { rsshub: fake('rsshub', [new XRateLimited('429', { retryAfter: 120 })]) },
  });

  const result = await fetchXSource(
    { social_ref: 'x:user:openai', feed_url: 'https://x.com/OpenAI', item_count: 10 },
    { runtime: { registry, sessions: null, onEvent: () => {} } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.throttled, true);
  assert.equal(result.retryAfter, 120);
});

test('an account that had posts and suddenly has none is treated as an anomaly (§16)', async () => {
  const registry = new XRegistry({
    env: { X_PRIMARY_PROVIDER: 'rsshub', X_FALLBACK_PROVIDERS: '' },
    providers: { rsshub: fake('rsshub', [[]]) },
  });

  const runtime = { registry, sessions: null, onEvent: () => {} };
  const feed = { social_ref: 'x:user:openai', feed_url: 'https://x.com/OpenAI' };

  // Never had any: an empty account is a real thing.
  const first = await fetchXSource({ ...feed, item_count: 0 }, { runtime });
  assert.equal(first.ok, true);
  assert.equal(first.feed.items.length, 0);

  // Had ten yesterday: believing zero would let one bad response decide this
  // feed is unchanging.
  const second = await fetchXSource({ ...feed, item_count: 10 }, { runtime });
  assert.equal(second.ok, false);
  assert.equal(second.throttled, true);
  assert.equal(second.error, 'empty-result');
});

test('a source whose ref we cannot read fails loudly rather than crawling nothing', async () => {
  const result = await fetchXSource(
    { social_ref: 'nonsense', feed_url: 'https://x.com/x' },
    { runtime: { registry: null, sessions: null, onEvent: () => {} } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid-x-ref');
});

/* --------------------------------------------- what a failure may cost a source */

/*
 * `markCrawlFailure` retires a feed at ten consecutive failures and an X source
 * polls on a five-minute floor, so ten strikes is fifty minutes. That arithmetic
 * is why exactly one of the four errors may reach it.
 */

/** @param {Error} error */
async function failWith(error) {
  const registry = new XRegistry({
    env: { X_PRIMARY_PROVIDER: 'rsshub', X_FALLBACK_PROVIDERS: '' },
    providers: { rsshub: fake('rsshub', [error]) },
  });

  return fetchXSource(
    { social_ref: 'x:user:openai', feed_url: 'https://x.com/OpenAI', item_count: 5 },
    { runtime: { registry, sessions: null, onEvent: () => {} } },
  );
}

test('only a missing account counts against the source', async () => {
  const gone = await failWith(new XNoSuchSource('no such account'));
  assert.equal(gone.ok, false);
  assert.equal(gone.throttled, undefined, 'a deleted account is a fact about the account');
});

test('a provider outage reschedules rather than blaming the account', async () => {
  const down = await failWith(new XUnavailable('rsshub: upstream-502'));
  assert.equal(down.ok, false);
  assert.equal(down.throttled, true);
  assert.ok(down.retryAfter > 0);
});

test('a dead session reschedules — it is our credential, not their account', async () => {
  const dead = await failWith(new XAuthFailed('auth-failed-401'));
  assert.equal(dead.throttled, true);
});

test('X switched on before a provider exists must not retire the directory', async () => {
  // The ordinary order of operations: the flag is how you find out whether the
  // provider is reachable. With no provider configured the registry refuses
  // outright, and that refusal must never look like a broken account.
  const registry = new XRegistry({
    env: { X_PRIMARY_PROVIDER: 'rsshub', X_FALLBACK_PROVIDERS: '' },
    providers: {
      rsshub: { ...fake('rsshub', [[]]), configured: () => false },
    },
  });

  const result = await fetchXSource(
    { social_ref: 'x:user:openai', feed_url: 'https://x.com/OpenAI', item_count: 5 },
    { runtime: { registry, sessions: null, onEvent: () => {} } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.throttled, true, 'no provider configured is a deployment state, not a dead account');
  // An hour, not ten minutes: nothing changes until somebody deploys something.
  assert.equal(result.retryAfter, 3600);
});

test('a rate limit still carries the interval the server named', async () => {
  const limited = await failWith(new XRateLimited('429', { retryAfter: 90 }));
  assert.equal(limited.throttled, true);
  assert.equal(limited.retryAfter, 90);

  // And falls back to something sane when it named none.
  const bare = await failWith(new XRateLimited('429'));
  assert.ok(bare.retryAfter > 0);
});
