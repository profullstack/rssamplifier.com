import test from 'node:test';
import assert from 'node:assert/strict';

import { XMLParser, XMLValidator } from 'fast-xml-parser';

import {
  AD_EVERY,
  AD_MAX,
  adSlotsFor,
  buildAtom,
  buildJsonFeed,
  buildM3u,
  buildPls,
  buildRss,
  interleaveAds,
} from '../src/syndicate.js';

// A sponsored item is the one entry in these documents we did not read off a
// publisher — it is third-party copy we insert ourselves. So what is tested
// here is that it cannot break the document it is inserted into, that a reader
// can always tell it apart from a post, and that it lands where it was meant
// to rather than at the top or the end.

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });

const channel = {
  title: 'physics — RSS Amplifier',
  description: 'Recent posts from the feeds that cover physics.',
  link: 'https://rssamplifier.com/topics/physics',
  selfUrl: 'https://rssamplifier.com/topics/physics.rss',
};

const post = (n) => ({
  id: `https://example.com/posts/${n}`,
  url: `https://example.com/posts/${n}`,
  title: `Post ${n}`,
  summary: 'A real post from a real blog.',
  published_at: '2026-08-18T09:00:00.000Z',
  feed_title: 'Example Blog',
  feed_url: 'https://example.com/feed.xml',
});

const posts = (n) => Array.from({ length: n }, (_, i) => post(i + 1));

const ad = {
  id: 'tag:crawlproof.com,2026:ad/slot-1/d/2026-08-18',
  url: 'https://crawlproof.com/api/ads/click?i=imp-1&s=slot-1&c=camp-1',
  title: '[Sponsored] Ship faster with Widgets',
  summary: 'Deploy in one command, roll back in one more.',
  content_html: '<p><strong>Sponsored</strong> · <a href="https://x.example">Widgets</a></p>',
  published_at: '2026-08-18T00:00:00.000Z',
  sponsored: true,
};

test('interleaveAds places one ad per interval, after real posts', () => {
  const out = interleaveAds(posts(30), [ad, { ...ad, id: 'ad-2' }, { ...ad, id: 'ad-3' }]);

  // Boundaries fall after the 10th, 20th and 30th post. The 30th is the last
  // one and an ad may never trail the feed, so that ad steps back a post and
  // follows the 29th instead of being dropped: 30 posts + 3 ads.
  assert.equal(out.length, 33);
  assert.equal(out[10].sponsored, true);
  assert.equal(out[21].sponsored, true);
  assert.equal(out[31].sponsored, true);
  assert.equal(out.filter((i) => i.sponsored).length, 3);
  assert.equal(out.at(-1).sponsored, undefined, 'a feed must not end on an ad');
});

test('adSlotsFor predicts exactly what interleaveAds will place', () => {
  // The contract that keeps an impression from being metered for an ad that is
  // then dropped on the floor.
  const many = Array.from({ length: 20 }, (_, i) => ({ ...ad, id: `ad-${i}` }));
  for (const total of [0, 1, 9, 10, 11, 19, 20, 21, 29, 30, 31, 50, 200]) {
    assert.equal(
      interleaveAds(posts(total), many).filter((i) => i.sponsored).length,
      adSlotsFor(total),
      `total=${total}`,
    );
  }
});

test('a feed of exactly ten items carries an ad, one post from the end', () => {
  // The shape this rule was rewritten for. Ten is the number an RSS document
  // conventionally holds, and it is by far the commonest length in the
  // directory: 32,114 of the 83,940 feeds that have items carry exactly ten. The
  // only boundary in such a list falls at the very end, so the original rule
  // dropped it and served no ad at all -- 38% of the per-listing feeds were
  // unsellable by arithmetic, which is what /camera-loopt.rss was showing.
  const out = interleaveAds(posts(10), [ad]);

  assert.equal(out.length, 11);
  assert.equal(adSlotsFor(10), 1, 'and the fetch count must agree');
  assert.equal(out[9].sponsored, true, 'the ad follows the ninth post');
  assert.equal(out.at(-1).sponsored, undefined, 'a real post still ends the feed');
  assert.equal(out.filter((i) => i.sponsored).length, 1);
});

test('a feed too short for one full interval still carries nothing', () => {
  // The step-back must not become a way in for lists that were always meant to
  // be left alone: an ad among six posts is the feed, not an ad in it.
  for (const total of [0, 1, 5, 9]) {
    assert.equal(adSlotsFor(total), 0, `total=${total}`);
    assert.equal(interleaveAds(posts(total), [ad]).filter((i) => i.sponsored).length, 0);
  }
});

test('two sponsored items are never adjacent', () => {
  // Stepping the last ad back moves it toward the one before it. At the
  // interval's own multiples that is safe, but the invariant is what matters:
  // a reader must never meet two adverts in a row.
  const many = Array.from({ length: 20 }, (_, i) => ({ ...ad, id: `ad-${i}` }));
  for (let total = 0; total <= 60; total += 1) {
    const out = interleaveAds(posts(total), many);
    for (let i = 1; i < out.length; i += 1) {
      assert.ok(
        !(out[i].sponsored && out[i - 1].sponsored),
        `two ads in a row at total=${total}, index=${i}`,
      );
    }
  }
});

test('an ad is dated to sort after the post it follows, not above the feed', () => {
  // The bug this exists to prevent: ads dated "start of today" while the newest
  // post in the river is a day older, so every reader -- which orders by date,
  // not by document position -- floated all three above every real post and
  // showed them as a block of adverts at the top of the feed.
  const dated = Array.from({ length: 30 }, (_, i) => ({
    ...post(i + 1),
    published_at: new Date(Date.UTC(2026, 7, 17 - i, 12, 0, 0)).toISOString(),
  }));
  const ads = [0, 1, 2].map((i) => ({ ...ad, id: `ad-${i}`, published_at: '2026-08-18T00:00:00.000Z' }));

  const out = interleaveAds(dated, ads);
  const placed = out.filter((i) => i.sponsored);
  assert.equal(placed.length, 3);

  // Each ad is strictly older than the post before it and strictly newer than
  // the post after it, so document order and reader order agree.
  for (const a of placed) {
    const at = out.indexOf(a);
    assert.ok(
      new Date(a.published_at) < new Date(out[at - 1].published_at),
      'ad must sort below the post it follows',
    );
    assert.ok(
      new Date(a.published_at) > new Date(out[at + 1].published_at),
      'ad must sort above the post after it',
    );
  }

  // And none of them outranks the newest real post.
  const newestPost = out.find((i) => !i.sponsored);
  for (const a of placed) {
    assert.ok(new Date(a.published_at) < new Date(newestPost.published_at));
  }

  // Sorting the document the way a reader does must not move anything.
  const bySortedDate = [...out].sort(
    (x, y) => new Date(y.published_at) - new Date(x.published_at),
  );
  assert.deepEqual(bySortedDate.map((i) => i.id), out.map((i) => i.id));
});

test('two ads in one feed never share a timestamp', () => {
  // Identical dates are what made them arrive as one clump rather than spread
  // through the river.
  const dated = Array.from({ length: 30 }, (_, i) => ({
    ...post(i + 1),
    published_at: new Date(Date.UTC(2026, 7, 17 - i, 12, 0, 0)).toISOString(),
  }));
  const out = interleaveAds(dated, [0, 1, 2].map((i) => ({ ...ad, id: `ad-${i}` })));
  const stamps = out.filter((i) => i.sponsored).map((i) => i.published_at);
  assert.equal(new Set(stamps).size, stamps.length);
});

test('an undated neighbour leaves the ad dated as it arrived', () => {
  // Plenty of rows genuinely have no date; inventing one for the neighbour
  // would be worse than leaving the ad where it was.
  const undated = Array.from({ length: 20 }, (_, i) => ({ ...post(i + 1), published_at: null }));
  const out = interleaveAds(undated, [ad]);
  assert.equal(out.find((i) => i.sponsored).published_at, ad.published_at);
});

test('re-dating does not touch the identity a reader dedupes on', () => {
  const dated = Array.from({ length: 20 }, (_, i) => ({
    ...post(i + 1),
    published_at: new Date(Date.UTC(2026, 7, 17 - i, 12, 0, 0)).toISOString(),
  }));
  const out = interleaveAds(dated, [ad]);
  assert.equal(out.find((i) => i.sponsored).id, ad.id);
});

test('interleaveAds leaves a short list alone', () => {
  // Nine posts cannot carry an ad without the ad becoming the feed.
  const short = posts(AD_EVERY - 1);
  assert.deepEqual(interleaveAds(short, [ad]), short);
});

test('interleaveAds honours the cap on a long feed', () => {
  // 200 items at one in ten would be twenty ads without the ceiling.
  const out = interleaveAds(posts(200), Array.from({ length: 20 }, (_, i) => ({ ...ad, id: `ad-${i}` })));
  assert.equal(out.filter((i) => i.sponsored).length, AD_MAX);
});

test('interleaveAds is a no-op when nothing was sold', () => {
  const items = posts(50);
  assert.deepEqual(interleaveAds(items, []), items);
  assert.deepEqual(interleaveAds(items, null), items);
});

test('a sponsored item does not break the RSS document', () => {
  const xml = buildRss(channel, interleaveAds(posts(20), [ad]));
  assert.equal(XMLValidator.validate(xml), true);

  const parsed = parser.parse(xml);
  const found = parsed.rss.channel.item.find((i) => i.category === 'Sponsored');

  assert.ok(found, 'the ad is labelled with a category a reader can filter on');
  assert.equal(found.title, ad.title);
  // The click URL, not the advertiser's own: that redirector is what meters the
  // click and pays us. Linking the advertiser directly would serve it for free.
  assert.equal(found.link, ad.url);
  // fast-xml-parser hands attributes back as strings unless told otherwise.
  assert.equal(found.guid['@isPermaLink'], 'false');
  assert.match(String(found.description), /Sponsored/);
});

test('a sponsored item does not break the Atom document', () => {
  const xml = buildAtom(channel, interleaveAds(posts(20), [ad]));
  assert.equal(XMLValidator.validate(xml), true);

  const parsed = parser.parse(xml);
  const found = parsed.feed.entry.find((e) => e.rights === 'Sponsored');

  assert.ok(found);
  assert.equal(found.category['@term'], 'sponsored');
  assert.equal(found.id, ad.id);
  assert.ok(found.content, 'the ad body rides in <content>, not <summary>');
});

test('a sponsored item is marked in JSON Feed for humans and for agents', () => {
  const doc = JSON.parse(buildJsonFeed(channel, interleaveAds(posts(20), [ad])));
  const found = doc.items.find((i) => i._crawlproof);

  assert.ok(found);
  assert.equal(found._crawlproof.sponsored, true);
  assert.deepEqual(found.tags, ['Sponsored']);
  assert.equal(found.content_html, ad.content_html);
});

test('advertiser copy that is itself markup cannot escape its element', () => {
  const hostile = {
    ...ad,
    title: 'Buy </title></item><item><title>Injected',
    content_html: 'ends with ]]> a terminator',
  };
  const xml = buildRss(channel, interleaveAds(posts(20), [hostile]));

  assert.equal(XMLValidator.validate(xml), true);
  const parsed = parser.parse(xml);
  // 20 posts + 1 ad. An injected <item> would make it 22.
  assert.equal(parsed.rss.channel.item.length, 21);
  const found = parsed.rss.channel.item.find((i) => i.category === 'Sponsored');
  assert.equal(found.description, 'ends with ]]> a terminator');
});

test('a real post still renders exactly as it did', () => {
  // content_html and sponsored are opt-in; a crawled post carries neither, and
  // its body must stay the plain-text summary it has always been.
  const xml = buildRss(channel, posts(2));
  const parsed = parser.parse(xml);

  assert.equal(parsed.rss.channel.item[0].description, 'A real post from a real blog.');
  assert.equal(parsed.rss.channel.item[0].category, undefined);
  assert.equal(XMLValidator.validate(xml), true);
});

test('playlists carry no ads, because an ad is not playable', () => {
  // The call sites do not splice into media formats at all, but if one ever
  // did, a sponsored line has no enclosure and must be skipped rather than
  // handed to a player as a file it cannot open.
  const mixed = interleaveAds(
    posts(20).map((p) => ({ ...p, audio_url: 'https://example.com/a.mp3' })),
    [ad],
  );

  const m3u = buildM3u(channel, mixed);
  const pls = buildPls(channel, mixed);

  assert.ok(!m3u.includes('Sponsored'));
  assert.ok(!pls.includes('Sponsored'));
  assert.match(pls, /NumberOfEntries=20/);
});
