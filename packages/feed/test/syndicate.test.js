import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { XMLParser } from 'fast-xml-parser';

import {
  SYNDICATION_FORMATS,
  buildAtom,
  buildJsonFeed,
  buildM3u,
  buildPls,
  buildRss,
  buildSyndication,
  playable,
  rfc822,
} from '../src/syndicate.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });

const channel = {
  title: 'physics — RSS Amplifier',
  description: 'Recent posts from the 128 feeds that cover physics.',
  link: 'https://rssamplifier.com/topics/physics',
  selfUrl: 'https://rssamplifier.com/topics/physics.rss',
};

const items = [
  {
    id: 'https://example.com/posts/1',
    guid: 'https://example.com/posts/1',
    url: 'https://example.com/posts/1',
    title: 'Entanglement, briefly',
    summary: 'A short note.',
    author: 'A. Writer',
    published_at: '2026-08-15T09:30:00.000Z',
    feed_title: 'Quantum Notes',
    feed_slug: 'quantum-notes',
    feed_url: 'https://example.com/feed.xml',
    audio_url: null,
    audio_type: null,
    audio_seconds: null,
  },
  {
    id: 'tag:example.org,2026:episode-7',
    url: 'https://example.org/ep7',
    title: 'Episode 7',
    summary: null,
    author: null,
    published_at: '2026-08-14T00:00:00.000Z',
    feed_title: 'The Physics Hour',
    feed_slug: 'the-physics-hour',
    audio_url: 'https://cdn.example.org/ep7.mp3',
    audio_type: 'audio/mpeg',
    audio_bytes: 41_000_000,
    audio_seconds: 3661,
  },
];

test('rss is well-formed and carries the channel, items and enclosure', () => {
  const doc = parser.parse(buildRss(channel, items));
  const rss = doc.rss.channel;

  assert.equal(rss.title, 'physics — RSS Amplifier');
  assert.equal(rss.link, 'https://rssamplifier.com/topics/physics');
  assert.equal(rss['atom:link']['@href'], channel.selfUrl);
  assert.equal(rss['atom:link']['@rel'], 'self');

  assert.equal(rss.item.length, 2);
  assert.equal(rss.item[0].title, 'Entanglement, briefly');
  assert.equal(rss.item[0]['dc:creator'], 'A. Writer');
  // The publication each post came from — a river is unreadable without it.
  assert.equal(rss.item[0].source['#text'], 'Quantum Notes');
  assert.equal(rss.item[0].source['@url'], 'https://example.com/feed.xml');
  assert.match(rss.item[0].pubDate, /^Sat, 15 Aug 2026 09:30:00 GMT$/);

  const enclosure = rss.item[1].enclosure;
  assert.equal(enclosure['@url'], 'https://cdn.example.org/ep7.mp3');
  assert.equal(enclosure['@type'], 'audio/mpeg');
  assert.equal(enclosure['@length'], '41000000');
  assert.equal(rss.item[1]['itunes:duration'], '01:01:01');
});

test('atom gives every entry an id and an updated, even undated ones', () => {
  const undated = [{ id: '12345', url: 'https://example.com/x', title: 'No date here' }];
  const xml = buildAtom({ ...channel, updated: '2026-08-16T00:00:00.000Z' }, undated);
  const entry = parser.parse(xml).feed.entry;

  // A bare integer is not an IRI, so it is namespaced under the feed rather
  // than emitted as an invalid id.
  assert.equal(entry.id, 'https://rssamplifier.com/topics/physics#12345');
  assert.equal(entry.updated, '2026-08-16T00:00:00.000Z');
  assert.equal(entry.published, undefined);
});

test('atom keeps an absolute guid as the id and links self and alternate', () => {
  const feed = parser.parse(buildAtom(channel, items)).feed;

  assert.equal(feed.entry[1].id, 'tag:example.org,2026:episode-7');

  const links = feed.link.map((l) => [l['@rel'], l['@href']]);
  assert.deepEqual(
    links.find(([rel]) => rel === 'self'),
    ['self', channel.selfUrl],
  );
  assert.deepEqual(
    links.find(([rel]) => rel === 'alternate'),
    ['alternate', channel.link],
  );
});

test('json feed is valid 1.1 with attachments', () => {
  const doc = JSON.parse(buildJsonFeed(channel, items));

  assert.equal(doc.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(doc.feed_url, channel.selfUrl);
  assert.equal(doc.home_page_url, channel.link);
  assert.equal(doc.items.length, 2);

  assert.deepEqual(doc.items[0].authors, [{ name: 'A. Writer' }]);
  assert.equal(doc.items[0]._rssamplifier.feed_title, 'Quantum Notes');
  assert.equal(
    doc.items[0]._rssamplifier.feed_page,
    'https://rssamplifier.com/quantum-notes',
  );

  assert.deepEqual(doc.items[1].attachments, [
    {
      url: 'https://cdn.example.org/ep7.mp3',
      mime_type: 'audio/mpeg',
      duration_in_seconds: 3661,
      size_in_bytes: 41_000_000,
    },
  ]);
});

test('m3u lists only the playable items, titled by publication', () => {
  const lines = buildM3u(channel, items).trim().split('\n');

  assert.equal(lines[0], '#EXTM3U');
  assert.equal(lines[1], '#PLAYLIST:physics — RSS Amplifier');
  assert.equal(lines[2], '#EXTINF:3661,The Physics Hour - Episode 7');
  assert.equal(lines[3], 'https://cdn.example.org/ep7.mp3');
  // The post with no audio contributes nothing.
  assert.equal(lines.length, 4);
});

test('m3u writes -1 for an unknown duration', () => {
  const live = [
    { id: 'x', title: 'Radio X', audio_url: 'https://ice.example/x', audio_type: '', audio_seconds: null },
  ];
  assert.match(buildM3u(channel, live), /^#EXTINF:-1,Radio X$/m);
});

test('pls numbers contiguously and counts what it wrote', () => {
  const text = buildPls(channel, items);

  assert.match(text, /^\[playlist\]$/m);
  assert.match(text, /^File1=https:\/\/cdn\.example\.org\/ep7\.mp3$/m);
  assert.match(text, /^Title1=The Physics Hour - Episode 7$/m);
  assert.match(text, /^Length1=3661$/m);
  assert.match(text, /^NumberOfEntries=1$/m);
  assert.match(text, /^Version=2$/m);
  // The unplayable item must not leave a hole in the numbering.
  assert.doesNotMatch(text, /^File2=/m);
});

test('a youtube embed is kept out of the playlists but stays in the feeds', () => {
  const yt = [
    {
      id: 'v1',
      url: 'https://example.com/watch',
      title: 'A lecture',
      audio_url: 'https://www.youtube-nocookie.com/embed/abcdefg',
      audio_type: 'video/youtube',
    },
  ];

  assert.equal(playable(yt[0]), false);
  // The URL is an iframe document, not a stream: handed to a player it errors.
  assert.doesNotMatch(buildM3u(channel, yt), /youtube/);
  assert.match(buildPls(channel, yt), /^NumberOfEntries=0$/m);
  // In RSS it is merely an enclosure of a type the reader does not know, and
  // dropping the item entirely would lose a post that is otherwise fine.
  assert.match(buildRss(channel, yt), /<title>A lecture<\/title>/);
});

test('a non-http media url is not playable', () => {
  assert.equal(playable({ audio_url: 'file:///home/me/track.mp3' }), false);
  assert.equal(playable({ audio_url: '' }), false);
  assert.equal(playable({ audio_url: 'https://ok.example/a.mp3' }), true);
});

test('titles from other peoples feeds cannot break the documents', () => {
  const hostile = [
    {
      id: 'h1',
      url: 'https://example.com/h',
      title: 'Bell & Bohr <script>alert("x")</script>',
      author: "O'Brien",
      audio_url: 'https://cdn.example/h.mp3',
      audio_type: 'audio/mpeg',
    },
    {
      id: 'h2',
      url: 'https://example.com/h2',
      // A newline in a playlist is not a formatting problem: it is an extra
      // entry pointing at whatever the rest of the title looks like.
      title: 'Line one\nFile2=https://evil.example/pwn.mp3',
      audio_url: 'https://cdn.example/h2.mp3',
      audio_type: 'audio/mpeg',
    },
  ];

  // Parses, which is the whole claim: an unescaped < or & makes it fail here.
  const rss = parser.parse(buildRss(channel, hostile));
  assert.equal(rss.rss.channel.item[0].title, 'Bell & Bohr <script>alert("x")</script>');
  assert.doesNotThrow(() => parser.parse(buildAtom(channel, hostile)));

  const m3u = buildM3u(channel, hostile);
  const lines = m3u.trim().split('\n');
  assert.equal(lines.length, 6, 'header, playlist name, two entries');
  // The injected text survives as part of the title, which is harmless — what
  // must not happen is it becoming a line of its own, because an m3u line that
  // is not a directive is a track, and the playlist would have gained an entry
  // pointing wherever the feed said.
  assert.deepEqual(
    lines.filter((line) => !line.startsWith('#')),
    ['https://cdn.example/h.mp3', 'https://cdn.example/h2.mp3'],
  );

  const pls = buildPls(channel, hostile);
  assert.match(pls, /^NumberOfEntries=2$/m);
  assert.doesNotMatch(pls, /^File2=https:\/\/evil\.example/m);
});

test('control characters XML forbids are stripped rather than escaped', () => {
  // \u0001 and \u000B have no escape in XML 1.0 and no legal representation in
  // a document: a parser handed one fails outright rather than recovering. They
  // turn up in scraped titles often enough to be worth stripping.
  const nasty = [{ id: 'c1', url: 'https://e.example/c', title: 'bad\u0001char\u000Bhere' }];
  const xml = buildRss(channel, nasty);

  assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  assert.equal(parser.parse(xml).rss.channel.item.title, 'badcharhere');
});

test('an empty topic still produces a valid document in every format', () => {
  for (const format of SYNDICATION_FORMATS.keys()) {
    const body = buildSyndication(format, channel, []);
    assert.ok(body.length > 0, `${format} produced nothing`);

    if (format === 'json') assert.equal(JSON.parse(body).items.length, 0);
    else if (format === 'pls') assert.match(body, /^NumberOfEntries=0$/m);
    else if (format === 'm3u') assert.match(body, /^#EXTM3U$/m);
    else assert.doesNotThrow(() => parser.parse(body), `${format} did not parse`);
  }
});

test('buildSyndication refuses an unknown format', () => {
  assert.throws(() => buildSyndication('opml', channel, items), /unknown syndication format/);
});

test('rfc822 renders UTC with English day and month names', () => {
  assert.equal(rfc822('2026-01-04T05:06:07.000Z'), 'Sun, 04 Jan 2026 05:06:07 GMT');
  assert.equal(rfc822('not a date'), '');
});

test('the rewrite rule offers exactly the formats that exist', () => {
  // next.config.mjs cannot import SYNDICATION_FORMATS — it is evaluated before
  // the workspace resolves — so the extension list is duplicated there. This is
  // the check that keeps the copy honest: adding a format without updating the
  // rewrite would ship a route nothing can reach.
  const config = readFileSync(new URL('../../../apps/web/next.config.mjs', import.meta.url), 'utf8');
  const rule = /\/topics\/:slug\.:format\(([a-z0-9|]+)\)/.exec(config);

  assert.ok(rule, 'no topic syndication rewrite found in next.config.mjs');
  assert.deepEqual(rule[1].split('|').sort(), [...SYNDICATION_FORMATS.keys()].sort());
});

test('a post picture rides along in every format that can carry one', () => {
  // Round-trips through our own parser on purpose: the crawler reads
  // media:thumbnail, so a document built here and crawled back keeps its
  // pictures rather than losing them at the boundary between the two.
  const withImage = [{ ...items[0], image_url: 'https://example.com/hero.jpg' }];

  const rss = parser.parse(buildRss(channel, withImage));
  assert.equal(rss.rss.channel.item['media:thumbnail']['@url'], 'https://example.com/hero.jpg');

  const atom = parser.parse(buildAtom(channel, withImage));
  assert.equal(atom.feed.entry['media:thumbnail']['@url'], 'https://example.com/hero.jpg');

  const json = JSON.parse(buildJsonFeed(channel, withImage));
  assert.equal(json.items[0].image, 'https://example.com/hero.jpg');

  // And a post without one carries no empty element.
  assert.ok(!buildRss(channel, items).includes('media:thumbnail'));
  assert.ok(!buildAtom(channel, items).includes('media:thumbnail'));
});
