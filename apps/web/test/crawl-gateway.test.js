import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The crawl gateway, and robots.txt agreeing with it.
 *
 * The policy this covers: training crawlers pay, retrieval crawlers and people
 * read free, and the structured entry points are open to all of them. The
 * failure it is written against is the two halves drifting — robots.txt saying
 * one thing about a crawler and the 402 saying another — which is exactly what
 * happens when the lists are typed twice.
 *
 * Both are loaded with the payment variables unset, which is also how the
 * service runs until Railway has them: the gate still answers 402, with an
 * empty offer, and the test does not depend on a CoinPay key.
 */
delete process.env.COINPAY_X402_KEY;
delete process.env.CRAWL_PAY_TO;
delete process.env.SITE_URL;

const { gate, gateway, OPEN_PATHS } = await import('../src/lib/crawl-gateway.js');
const { GET: robots } = await import('../src/app/robots.txt/route.js');

// Real strings, as sent: everything below also claims to be Mozilla.
const UAS = {
  meta: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  claudebot: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  searchbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  chrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

const request = (path, ua, headers = {}) =>
  new Request(`https://rssamplifier.com${path}`, { headers: { 'user-agent': ua, ...headers } });

/**
 * robots.txt as a crawler reads it: one record per `User-agent` group.
 *
 * @param {string} body
 * @returns {Map<string, string[]>} agent -> its directive lines
 */
function groups(body) {
  const out = new Map();
  let agents = [];
  let rules = [];
  const close = () => {
    for (const a of agents) out.set(a.toLowerCase(), rules);
    agents = [];
    rules = [];
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [, key, value] = line.match(/^([^:]+):\s*(.*)$/) ?? [];
    if (!key) continue;
    if (/^user-agent$/i.test(key)) {
      if (rules.length) close();
      agents.push(value);
    } else if (agents.length) {
      rules.push(`${key}: ${value}`);
    }
  }
  close();
  return out;
}

test('robots.txt refuses the training crawlers and points them at the sale', async () => {
  const body = await robots().text();
  const g = groups(body);

  for (const agent of ['GPTBot', 'meta-externalagent', 'ClaudeBot', 'CCBot', 'Bytespider']) {
    const rules = g.get(agent.toLowerCase());
    assert.ok(rules, `${agent} is named, so it obeys its own group and not the wildcard`);
    assert.ok(rules.includes('Disallow: /'), `${agent} is refused`);
    assert.ok(rules.includes('Allow: /crawl'), `${agent} may still read where to pay`);
    assert.ok(!rules.includes('Allow: /'), `${agent} is not also welcomed`);
  }
});

test('robots.txt still welcomes the retrieval crawlers, by name', async () => {
  const g = groups(await robots().text());

  for (const agent of ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', '*']) {
    const rules = g.get(agent.toLowerCase());
    assert.ok(rules, `${agent} is named`);
    assert.ok(rules.includes('Allow: /'), `${agent} reads free`);
    assert.ok(!rules.includes('Disallow: /'), `${agent} is not refused`);
    // Named groups repeat the wildcard's rules, or the named crawler would
    // ignore them entirely and walk into the sign-in page.
    assert.ok(rules.includes('Disallow: /login'), `${agent} is kept out of /login`);
    assert.ok(rules.includes('Disallow: /api/'), `${agent} is kept out of the API`);
    assert.ok(rules.includes('Allow: /api/feeds'), `${agent} is still told about /api/feeds`);
  }
});

test('robots.txt keeps the sitemap and the entry points it used to advertise', async () => {
  const body = await robots().text();

  assert.match(body, /^Sitemap: https:\/\/rssamplifier\.com\/sitemap\.xml$/m);
  for (const path of ['/llms.txt', '/skill.md', '/api/feeds', '/opml', '/mcp', '/crawl']) {
    assert.match(body, new RegExp(`^#.*https://rssamplifier\\.com${path.replace('.', '\\.')}`, 'm'), `${path} is advertised`);
  }
});

test('a training crawler asking for a page is answered 402 with the offer', async () => {
  const answer = await gate(request('/feeds/anything', UAS.meta));

  assert.ok(answer, 'the gate answered');
  assert.equal(answer.status, 402);
  assert.match(answer.headers.get('content-type'), /application\/json/);
  assert.equal(answer.headers.get('cache-control'), 'no-store');

  const offer = await answer.json();
  assert.equal(offer.x402Version, 2);
  // No CoinPay key in this process: nothing for sale, but nothing given away.
  assert.deepEqual(offer.accepts, []);
  assert.equal(offer.pass.header, 'x-crawl-pass');
  assert.equal(offer.pass.buy, 'https://rssamplifier.com/crawl');

  // Asked for HTML, it gets the sales page instead of JSON.
  const page = await gate(request('/feeds/anything', UAS.gptbot, { accept: 'text/html,*/*' }));
  assert.equal(page.status, 402);
  assert.match(page.headers.get('content-type'), /text\/html/);
});

test('a person, a search engine and a retrieval crawler pass untouched', async () => {
  for (const ua of [UAS.chrome, UAS.googlebot, UAS.searchbot]) {
    assert.equal(await gate(request('/feeds/anything', ua)), undefined, ua);
    assert.equal(await gate(request('/', ua)), undefined, ua);
  }
});

test('the entry points are open to a training crawler, being the point', async () => {
  for (const path of [...OPEN_PATHS, '/robots.txt']) {
    assert.equal(await gate(request(path, UAS.claudebot)), undefined, `${path} is not charged`);
  }
  // And the neighbours of an open path are not: the match is exact.
  assert.equal((await gate(request('/api/feeds/some-slug/feed/rss', UAS.claudebot)))?.status, 402);
});

test('the sales page answers everyone, whatever they wear', async () => {
  const page = await gate(request('/crawl', UAS.chrome, { accept: 'text/html' }));
  assert.equal(page?.status, 402);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(gateway.enabled, false, 'no key, no payout address: payments are off in this process');
});

/**
 * The proxy, read out of proxy.js itself.
 *
 * proxy.js cannot be imported here: it pulls in `next/server`, which has no
 * ESM export map for plain Node. So its shape is read back from the source,
 * the way test/proxy.test.js reads the matcher — the gate has to run before the
 * throttle, and the matcher has to let both the sales page and the pages a
 * crawler wants through to it.
 */
function proxySource() {
  return readFileSync(fileURLToPath(new URL('../src/proxy.js', import.meta.url)), 'utf8');
}

test('the proxy asks the gate first', () => {
  const src = proxySource();
  const gateAt = src.indexOf('await gate(request)');
  const throttleAt = src.indexOf('attempt(callerIdentity(request)');

  assert.ok(gateAt > 0, 'the proxy awaits the gate');
  assert.ok(throttleAt > gateAt, 'and does so before the throttle spends an allowance on a 402');
  assert.match(src, /if \(answer\) \{[\s\S]*?return answer;/, 'an answer from the gate is the response');
});

test('the matcher lets the gate see what a crawler is after', () => {
  const [, literal] = proxySource().match(/matcher: \[\s*'((?:[^'\\]|\\.)*)'/) ?? [];
  assert.ok(literal, 'proxy.js still exports a config.matcher as a single-quoted literal');
  const matches = (path) => new RegExp(`^${JSON.parse(`"${literal.replace(/"/g, '\\"')}"`)}$`).test(path);

  assert.ok(matches('/crawl'), 'the sales page is answered by the gate, not by [slug]');
  assert.ok(matches('/feeds/anything'));
  assert.ok(matches('/some-blog/read'), 'the page a corpus crawl is really after');
  assert.ok(!matches('/robots.txt'), 'the file that names the price is never in the way');
});
