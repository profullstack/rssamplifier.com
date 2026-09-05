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
 * Then the two callers that never name themselves — the OVH fleet in a
 * browser's clothes, and the residential-proxy rotation — and the callers who
 * have already said who they are and must never be caught in the net cast for
 * those two: readers with a session, programs with a key, search engines.
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
  // The three strings the residential-proxy rotation cycled on 2026-09-05.
  rotation: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  ],
  // Googlebot's evergreen string claims Chrome — its rendering engine — and
  // sends none of a browser's fetch-metadata headers.
  googlebotEvergreen:
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/145.0.0.0 Safari/537.36',
  bingbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
  appleExtended: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15 (Applebot-Extended/0.1; +https://support.apple.com/en-us/119829)',
};

/** What a real Chromium cannot help sending. */
const BROWSER = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };

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
  // A person's browser sends the fetch-metadata headers; the crawlers name
  // themselves. Neither is what any check here is for.
  for (const ua of [UAS.googlebot, UAS.searchbot]) {
    assert.equal(await gate(request('/feeds/anything', ua)), undefined, ua);
    assert.equal(await gate(request('/', ua)), undefined, ua);
  }
  assert.equal(await gate(request('/feeds/anything', UAS.chrome, BROWSER)), undefined);
  assert.equal(await gate(request('/', UAS.chrome, BROWSER)), undefined);
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

test('the OVH fleet is refused by address, whatever it wears', async () => {
  // vps-*.vps.ovh.net, measured 2026-08-28, spoofing Chrome/148. Not 402:
  // there is nothing on sale to a hosting range that will not say who it is.
  //
  // The address is the LAST hop of x-forwarded-for — the one our own edge
  // appended — or x-real-ip. The first entry is whatever the client put
  // there, which is why it is not read.
  for (const ip of ['51.38.12.7', '54.38.200.1', '141.94.94.32', '145.239.0.9', '149.202.77.77', '151.80.1.1', '57.129.3.3', '213.32.90.90']) {
    const answer = await gate(request('/topics/rust', UAS.chrome, { ...BROWSER, 'x-forwarded-for': `10.0.0.1, ${ip}` }));
    assert.equal(answer?.status, 403, `${ip} is refused`);
    assert.match(answer.headers.get('content-type'), /text\/plain/);
    assert.equal(answer.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await gate(request('/topics/rust', UAS.chrome, { ...BROWSER, 'x-forwarded-for': '54.38.1.2' })))?.status, 403, 'a single hop is the last hop');
  assert.equal((await gate(request('/topics/rust', UAS.chrome, { ...BROWSER, 'x-real-ip': '54.38.1.2' })))?.status, 403, 'the nginx spelling');

  // A client cannot put itself on the list by seeding the header, and cannot
  // take itself off it either: only the hop the edge added counts.
  assert.equal(await gate(request('/topics/rust', UAS.chrome, { ...BROWSER, 'x-forwarded-for': '54.38.1.2, 203.0.113.9' })), undefined, 'a seeded first entry is ignored');
  assert.equal((await gate(request('/topics/rust', UAS.chrome, { ...BROWSER, 'x-forwarded-for': '203.0.113.9, 54.38.1.2' })))?.status, 403);

  // The refusal is by range, so its neighbours outside the range are not it.
  assert.equal(await gate(request('/topics/rust', UAS.chrome, { ...BROWSER, 'x-forwarded-for': '51.39.0.1' })), undefined);
  // And a real reader's address is untouched, even on the list's home path.
  assert.equal(await gate(request('/', UAS.chrome, { ...BROWSER, 'x-forwarded-for': '203.0.113.9' })), undefined);
});

test('a Chrome string that cannot answer like Chrome is charged', async () => {
  // The rotation of 2026-09-05: three Chrome strings, five hundred addresses,
  // /topics/* at up to 250 requests a second. Every one of them missed the
  // header a browser cannot omit.
  for (const ua of UAS.rotation) {
    const answer = await gate(request('/topics/x', ua, { 'x-forwarded-for': '203.0.113.9' }));
    assert.equal(answer?.status, 402, ua);
    const offer = await answer.json();
    assert.equal(offer.pass.buy, 'https://rssamplifier.com/crawl');
  }
  // Same string, on the API and author pages it walked.
  assert.equal((await gate(request('/api/topics/x', UAS.rotation[0])))?.status, 402);
  assert.equal((await gate(request('/authors/somebody', UAS.rotation[2])))?.status, 402);
});

test('the same string with the header a browser sends passes', async () => {
  for (const ua of UAS.rotation) {
    assert.equal(await gate(request('/topics/x', ua, { 'sec-fetch-mode': 'navigate' })), undefined, ua);
  }
  // A fetch() from a page and a <script> load say so too, and are people.
  assert.equal(await gate(request('/api/topics/x', UAS.chrome, { 'sec-fetch-mode': 'cors' })), undefined);
  assert.equal(await gate(request('/topics/x', UAS.chrome, { 'sec-fetch-mode': 'no-cors' })), undefined);
});

test('a signed-in reader is never charged, headers or not', async () => {
  // The hint the masthead reads, and the session it describes; a request
  // carrying either has already said who it is.
  assert.equal(await gate(request('/topics/x', UAS.chrome, { cookie: 'signed_in=1' })), undefined);
  assert.equal(await gate(request('/topics/x', UAS.rotation[0], { cookie: 'theme=dark; signed_in=1' })), undefined);
  assert.equal(await gate(request('/topics/x', UAS.rotation[1], { cookie: 'rsa_session=a-token' })), undefined);
  // An emptied session is not a session, and a look-alike name is not the cookie.
  assert.equal((await gate(request('/topics/x', UAS.rotation[1], { cookie: 'rsa_session=' })))?.status, 402);
  assert.equal((await gate(request('/topics/x', UAS.rotation[1], { cookie: 'not_signed_in_at_all=1' })))?.status, 402);
});

test('a caller with an API key is placed by the tiers, not by the gate', async () => {
  const key = 'rsa_0123abcd_' + 'x'.repeat(32);
  assert.equal(await gate(request('/api/topics/x', UAS.chrome, { authorization: `Bearer ${key}` })), undefined);
  assert.equal(await gate(request('/api/topics/x', UAS.chrome, { 'x-api-key': key })), undefined);
  // The shape is checked and nothing else: a bearer token that is not one of
  // our keys is not an identity, so it is judged like everyone else.
  assert.equal((await gate(request('/api/topics/x', UAS.rotation[0], { authorization: 'Bearer nope' })))?.status, 402);
});

test('a crawler that names itself is not judged as a browser', async () => {
  // Googlebot and Bingbot both say Chrome and neither sends Sec-Fetch-Mode;
  // charging them would cut off the readers they send.
  assert.equal(await gate(request('/topics/x', UAS.googlebotEvergreen)), undefined);
  assert.equal(await gate(request('/topics/x', UAS.bingbot)), undefined);
  assert.equal(await gate(request('/topics/x', UAS.googlebot)), undefined);
  assert.equal(await gate(request('/topics/x', UAS.searchbot)), undefined);
  // But the exemption cannot be borrowed by the training half of a pair:
  // Applebot-Extended contains "Applebot" and is charged all the same.
  assert.equal((await gate(request('/topics/x', UAS.appleExtended)))?.status, 402);
  assert.equal((await gate(request('/topics/x', UAS.claudebot)))?.status, 402);
});

test('the sales page still answers, and the deny list still comes first there', async () => {
  const page = await gate(request('/crawl', UAS.rotation[0], { accept: 'text/html' }));
  assert.equal(page?.status, 402);
  assert.match(page.headers.get('content-type'), /text\/html/);

  const refused = await gate(request('/crawl', UAS.chrome, { ...BROWSER, 'x-forwarded-for': '203.0.113.9, 51.38.1.1' }));
  assert.equal(refused?.status, 403, 'nothing is on sale to the fleet');
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
