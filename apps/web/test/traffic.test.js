import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyAgent, classifyPath, record, drain, flush, reset } from '../src/lib/traffic.js';

// Real strings, as sent. Written out rather than reduced to the token being
// matched, because the whole difficulty of this classifier is that almost
// everything below also claims to be Mozilla.
const UAS = {
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  claudebot: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  perplexity: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot',
  ahrefs: 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  semrush: 'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  feedly: 'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
  curl: 'curl/8.5.0',
  python: 'python-requests/2.31.0',
  chrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

test('the AI crawlers robots.txt invites are told apart by vendor', () => {
  assert.equal(classifyAgent(UAS.gptbot), 'ai-openai');
  assert.equal(classifyAgent(UAS.claudebot), 'ai-anthropic');
  assert.equal(classifyAgent(UAS.perplexity), 'ai-perplexity');
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; CCBot/2.0; +https://commoncrawl.org/faq/)'), 'ai-commoncrawl');
  assert.equal(classifyAgent('Bytespider'), 'ai-bytedance');
});

test('a crawler that also claims to be a browser is not counted as one', () => {
  // Every string here contains "Mozilla" and most contain "Chrome" or "Safari".
  // If the browser test ran first, all of this would read as human traffic --
  // which is exactly how a million pageviews comes to look like an audience.
  for (const ua of [UAS.gptbot, UAS.claudebot, UAS.perplexity, UAS.ahrefs, UAS.semrush, UAS.googlebot]) {
    assert.notEqual(classifyAgent(ua), 'browser', ua);
  }
});

test('commercial SEO scrapers get their own bucket', () => {
  assert.equal(classifyAgent(UAS.ahrefs), 'seo-scraper');
  assert.equal(classifyAgent(UAS.semrush), 'seo-scraper');
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)'), 'seo-scraper');
});

test('search indexing is not lumped in with AI crawling', () => {
  // Googlebot and Google-Extended are different crawlers with different
  // bargains: one sends readers, the other trains on us. A tier that cannot
  // tell them apart has to choose the same answer for both.
  assert.equal(classifyAgent(UAS.googlebot), 'search-google');
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; Google-Extended/1.0)'), 'ai-google');
});

test('feed readers are recognised, being the subject matter', () => {
  assert.equal(classifyAgent(UAS.feedly), 'feed-reader');
  assert.equal(classifyAgent('Inoreader/1.0 (+http://www.inoreader.com/feed-fetcher)'), 'feed-reader');
  assert.equal(classifyAgent('NetNewsWire/6.1'), 'feed-reader');
});

test('scripted callers are separated from browsers', () => {
  assert.equal(classifyAgent(UAS.curl), 'tool');
  assert.equal(classifyAgent(UAS.python), 'tool');
  assert.equal(classifyAgent('Go-http-client/2.0'), 'tool');
});

test('actual browsers are the only thing left in browser', () => {
  assert.equal(classifyAgent(UAS.chrome), 'browser');
  assert.equal(classifyAgent(UAS.safari), 'browser');
});

test('an absent user-agent is its own bucket, not other', () => {
  assert.equal(classifyAgent(''), 'none');
  assert.equal(classifyAgent(null), 'none');
  assert.equal(classifyAgent(undefined), 'none');
  assert.equal(classifyAgent('   '), 'none');
});

test('an unrecognised self-declared bot is visible rather than folded away', () => {
  assert.equal(classifyAgent('SomeNewThing-Crawler/0.1'), 'bot-unknown');
  assert.equal(classifyAgent('acmebot'), 'bot-unknown');
});

test('routes are bucketed by what they cost, not by URL shape', () => {
  assert.equal(classifyPath('/'), 'page');
  assert.equal(classifyPath('/topics/rust'), 'page');
  assert.equal(classifyPath('/api/feeds'), 'api');
  assert.equal(classifyPath('/mcp'), 'mcp');
  assert.equal(classifyPath('/search'), 'search');

  // The expensive one: fetches and extracts a third-party page, and may pay an
  // LLM to translate it.
  assert.equal(classifyPath('/some-blog/read'), 'reader');
});

test('the cheap machine-readable entry points are counted apart', () => {
  // A crawler using these instead of walking 37 pages is the outcome the
  // robots.txt is asking for, so it has to be visible when it happens.
  for (const path of ['/llms.txt', '/skill.md', '/robots.txt', '/opml', '/sitemap.xml', '/topics/rust.rss']) {
    assert.equal(classifyPath(path), 'export', path);
  }
});

test('assets never reach the counters', () => {
  assert.equal(classifyPath('/_next/static/chunks/main.js'), 'asset');
  assert.equal(classifyPath('/logo.png'), 'asset');
  assert.equal(classifyPath('/fonts/inter.woff2'), 'asset');
});

test('hits accumulate per hour, agent, bucket and tier', () => {
  reset();
  record({ hour: '2026-09-02T10', agent: 'ai-openai', bucket: 'page', tier: 'anon' });
  record({ hour: '2026-09-02T10', agent: 'ai-openai', bucket: 'page', tier: 'anon' });
  record({ hour: '2026-09-02T10', agent: 'browser', bucket: 'page', tier: 'anon' });

  const rows = drain();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.agent === 'ai-openai').hits, 2);
  assert.equal(rows.find((r) => r.agent === 'browser').hits, 1);
});

test('the same request on two tiers is counted apart', () => {
  // The whole point of the tier column: "how much of our traffic is signed in"
  // is the number that decides whether an authenticated allowance is worth
  // anything, and it is unanswerable if the tiers are summed together.
  reset();
  record({ hour: '2026-09-02T10', agent: 'browser', bucket: 'page', tier: 'anon' });
  record({ hour: '2026-09-02T10', agent: 'browser', bucket: 'page', tier: 'session' });

  const rows = drain();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.tier).sort(),
    ['anon', 'session'],
  );
});

test('every part of the key survives the round trip', () => {
  reset();
  record({ hour: '2026-09-02T10', agent: 'seo-scraper', bucket: 'reader', tier: 'key' });

  assert.deepEqual(drain(), [
    {
      hour: '2026-09-02T10',
      agent: 'seo-scraper',
      bucket: 'reader',
      tier: 'key',
      hits: 1,
      refused: 0,
    },
  ]);
});

test('a refused request is still counted as a request', () => {
  // The property that must not regress. If refusals stopped being counted, a
  // limit turning away half the traffic would read as the traffic having gone
  // away -- which is the same shape as success and the opposite of it.
  reset();
  record({ hour: '2026-09-02T10', agent: 'seo-scraper', bucket: 'page', tier: 'anon', refused: true });

  const [row] = drain();
  assert.equal(row.hits, 1, 'it counts toward what was asked for');
  assert.equal(row.refused, 1, 'and is marked as turned away');
});

test('hits and refusals accumulate independently', () => {
  reset();
  const key = { hour: '2026-09-02T10', agent: 'ai-openai', bucket: 'api', tier: 'anon' };
  record({ ...key });
  record({ ...key, refused: true });
  record({ ...key, refused: true });

  const [row] = drain();
  assert.equal(row.hits, 3);
  assert.equal(row.refused, 2, 'two of the three were turned away');
});

test('a refused and an allowed request share one row', () => {
  // Refused is a property of a request, not a kind of request. Making it part
  // of the key would double the rows and make every existing query silently
  // report half the traffic.
  reset();
  record({ hour: '2026-09-02T10', agent: 'browser', bucket: 'page', tier: 'anon' });
  record({ hour: '2026-09-02T10', agent: 'browser', bucket: 'page', tier: 'anon', refused: true });

  assert.equal(drain().length, 1);
});

test('draining empties the buffer so nothing is counted twice', () => {
  reset();
  record({ hour: '2026-09-02T10', agent: 'tool', bucket: 'api', tier: 'anon' });

  assert.equal(drain().length, 1);
  assert.equal(drain().length, 0);
});

test('a failed flush loses the counters instead of throwing', async () => {
  // The whole file runs inside the proxy, in front of every request. Anything
  // that escapes here is the site down for bookkeeping.
  reset();
  record({ hour: '2026-09-02T10', agent: 'tool', bucket: 'api', tier: 'anon' });

  await flush(async () => {
    throw new Error('database busy');
  });

  assert.equal(drain().length, 0);
});

test('a flush with nothing buffered does not touch the database', async () => {
  reset();
  let called = false;

  await flush(async () => {
    called = true;
  });

  assert.equal(called, false);
});
