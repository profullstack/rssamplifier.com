import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseList, candidatesFromList } from '../src/list.js';
import { instanceFeedUrl, peertubeInstances, peertubeCandidates } from '../src/peertube.js';
import { SOURCES, dueSources, sourceById } from '../src/sources.js';

/**
 * A fetch that answers with a canned body, and records what it was asked for.
 *
 * @param {string} body
 * @param {{ status?: number, json?: unknown }} [opts]
 */
function stubFetch(body, opts = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      text: async () => body,
      json: async () => opts.json ?? JSON.parse(body),
    };
  };
  impl.calls = calls;
  return impl;
}

// ------------------------------------------------------------------- lists

test('a list is read past its comments, blanks and duplicates', () => {
  // The real shape of Kagi's smallyt.txt: a URL, then a # comment carrying the
  // channel's title and page.
  const body = [
    '',
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC_A # Tom S https://youtube.com/channel/UC_A',
    '# a whole-line comment',
    '   ',
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC_B # Someone else',
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC_A # the same channel again',
  ].join('\n');

  assert.deepEqual(parseList(body), [
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC_A',
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC_B',
  ]);
});

test('a list of nothing is not an error', () => {
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList('# only a comment\n\n'), []);
});

test('list entries that are not URLs are dropped rather than queued', () => {
  const body = ['not a url', 'javascript:alert(1)', 'https://good.example/feed.xml'].join('\n');
  assert.deepEqual(parseList(body), ['https://good.example/feed.xml']);
});

test('a fetched list is capped by the caller', async () => {
  const body = Array.from({ length: 50 }, (_, i) => `https://x${i}.example/feed.xml`).join('\n');
  const urls = await candidatesFromList('https://lists.example/l.txt', {
    fetchImpl: stubFetch(body),
    limit: 5,
  });
  assert.equal(urls.length, 5);
});

test('a list that fails to fetch throws rather than returning nothing', async () => {
  await assert.rejects(
    () => candidatesFromList('https://lists.example/l.txt', { fetchImpl: stubFetch('', { status: 404 }) }),
    /404/,
  );
});

// ---------------------------------------------------------------- peertube

test('the live feed URL carries the filter that makes /lives possible', () => {
  assert.equal(instanceFeedUrl('tube.example', true), 'https://tube.example/feeds/videos.xml?isLive=true');
  assert.equal(instanceFeedUrl('tube.example', false), 'https://tube.example/feeds/videos.xml');
});

test('instances are filtered to ones that can actually stream', async () => {
  const fetchImpl = stubFetch('', {
    json: {
      data: [
        { host: 'live.example', liveEnabled: true },
        // The directory has been known to ignore an unfamiliar query parameter
        // rather than reject it, so the filter is applied here too — otherwise
        // /lives fills with instances that cannot stream.
        { host: 'novideo.example', liveEnabled: false },
        { host: 'unknown.example' },
      ],
    },
  });

  const hosts = await peertubeInstances({ fetchImpl, live: true });
  assert.deepEqual(hosts, ['live.example', 'unknown.example']);
  assert.ok(fetchImpl.calls[0].includes('liveEnabled=true'), 'asked the directory to filter too');
});

test('a hostname that is not a hostname never reaches a URL', async () => {
  const fetchImpl = stubFetch('', {
    json: {
      data: [
        { host: 'good.example' },
        { host: 'evil.example/../../etc' },
        { host: 'http://not-a-host' },
        { host: '' },
      ],
    },
  });

  assert.deepEqual(await peertubeInstances({ fetchImpl }), ['good.example']);
});

test('peertube candidates are instance feed URLs', async () => {
  const fetchImpl = stubFetch('', { json: { data: [{ host: 'a.example', liveEnabled: true }] } });
  assert.deepEqual(await peertubeCandidates({ fetchImpl, live: true }), [
    'https://a.example/feeds/videos.xml?isLive=true',
  ]);
});

// ----------------------------------------------------------------- sources

test('every source declares a schedule and a sane category', () => {
  for (const source of SOURCES) {
    assert.ok(source.everyHours > 0, `${source.id} has no schedule`);
    assert.ok(source.limit > 0, `${source.id} has no cap`);
    // A curated source must say what it is vouching for; an uncurated one must
    // not, because its category is whatever the parser decides.
    if (source.curated) assert.ok(source.category, `${source.id} is curated but names no category`);
    else assert.equal(source.category, null, `${source.id} is not curated but names a category`);
  }
});

test('the categories no parser can reach each have a source', () => {
  // The point of the whole module: /comics, /lives and /music cannot fill
  // themselves. Music is here because it stopped being inferred from an audio
  // enclosure — that rule filed 198 blogs as music and found no music at all.
  for (const category of ['comic', 'live', 'music']) {
    assert.ok(
      SOURCES.some((s) => s.category === category && s.curated),
      `nothing fills /${category}`,
    );
  }
});

test('a source is due when it has never run, and not again until its interval', () => {
  const source = sourceById('kagi-yt');
  const now = new Date('2026-08-16T12:00:00Z');

  assert.ok(dueSources({}, now).some((s) => s.id === 'kagi-yt'), 'never run means due');

  const justRan = { 'kagi-yt': '2026-08-16T11:00:00Z' };
  assert.ok(!dueSources(justRan, now).some((s) => s.id === 'kagi-yt'), 'an hour ago is not due');

  const longAgo = { 'kagi-yt': '2026-08-14T11:00:00Z' };
  assert.ok(dueSources(longAgo, now).some((s) => s.id === 'kagi-yt'), 'two days ago is due');
  assert.equal(source.everyHours, 24);
});

test('an unparseable last-run timestamp makes a source due rather than stuck', () => {
  // A source that can never run again because of one bad row is the worse
  // failure: better to re-read a list than to silently stop.
  assert.ok(dueSources({ 'kagi-yt': 'not a date' }).some((s) => s.id === 'kagi-yt'));
});

// ------------------------------------------------------- candidate identity

test('feeds sharing a host are separate candidates', async () => {
  // The bug this exists for: a run's candidates are unique on (run_id, host),
  // which is right when a candidate is a website and wrong when it is a feed.
  // All 258 channels in the YouTube list live on youtube.com, so a host key
  // queued one of them and reported success.
  const { connect, migrate, discovery } = await import('@rssamplifier/db');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'rssamp-disc-'));
  const db = connect({ url: `file:${join(dir, 'd.db')}` });
  await migrate(db);

  const { runSource } = await import('../src/run.js');

  const channels = [
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC_A',
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC_B',
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC_C',
  ].join('\n');

  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => channels });

  const result = await runSource(db, 'kagi-yt', { fetchImpl });
  assert.equal(result.found, 3);
  assert.equal(result.queued, 3, 'every channel is its own candidate');

  const queued = await discovery.queuedCandidates(db, 10);
  assert.equal(queued.length, 3);
  // The run's claim travels with each candidate, so the poller knows to skip
  // worthiness and stamp the category.
  assert.equal(Number(queued[0].curated), 1);
  assert.equal(String(queued[0].category), 'video');

  await rm(dir, { recursive: true, force: true });
});

test('a source that cannot be reached records a failed run rather than throwing', async () => {
  const { connect, migrate, discovery } = await import('@rssamplifier/db');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'rssamp-disc2-'));
  const db = connect({ url: `file:${join(dir, 'd.db')}` });
  await migrate(db);

  const { runSource } = await import('../src/run.js');
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => '' });

  const result = await runSource(db, 'kagi-comics', { fetchImpl });
  assert.equal(result.queued, 0);
  assert.match(String(result.error), /503/);

  const runs = await discovery.recentRuns(db, 5);
  assert.equal(String(runs[0].status), 'failed', 'the outage is visible, not swallowed');

  await rm(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------- music

test('every hand-kept music feed is a distinct absolute URL', async () => {
  const { MUSIC_FEEDS } = await import('../src/music.js');

  assert.ok(MUSIC_FEEDS.length > 100, 'the list is the whole category, so it should not be thin');
  assert.equal(new Set(MUSIC_FEEDS).size, MUSIC_FEEDS.length, 'a URL is listed twice');

  for (const url of MUSIC_FEEDS) {
    // A relative URL would be queued and then fail to resolve, one candidate at
    // a time, with nothing saying the list was the problem.
    assert.doesNotThrow(() => new URL(url), `${url} is not a URL`);
    assert.match(url, /^https?:\/\//, `${url} is not http`);
  }
});

test('the music source hands back its list, capped', async () => {
  const source = sourceById('music');
  const { MUSIC_FEEDS } = await import('../src/music.js');

  assert.equal(source.category, 'music');
  assert.ok(source.curated, 'the half that declares nothing needs vouching for');

  assert.deepEqual(await source.run({ limit: 3 }), MUSIC_FEEDS.slice(0, 3));
  assert.equal((await source.run({ limit: source.limit })).length, MUSIC_FEEDS.length);
});

test('why a service is missing from the music list is written down', async () => {
  const { MUSIC_UNAVAILABLE } = await import('../src/music.js');

  // The same reasoning as UNAVAILABLE above: "why is Bandcamp not in here" is
  // a question with a factual answer, and it belongs next to the list.
  for (const entry of MUSIC_UNAVAILABLE) {
    assert.ok(entry.id, 'an entry with no id');
    assert.ok(entry.reason.length > 40, `${entry.id} gives no reason worth reading`);
  }
  assert.ok(MUSIC_UNAVAILABLE.some((e) => e.id === 'bandcamp'));
});
