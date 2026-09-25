import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SUBSCRIBE_FORMATS, feedAlternates, formatTitle } from '../src/lib/subscribe.js';
import { CATEGORIES, CATEGORY_SEGMENTS } from '../src/lib/categories.js';

const config = readFileSync(new URL('../next.config.mjs', import.meta.url), 'utf8');

test('a page advertises every format it links, at its own address', () => {
  const types = feedAlternates('https://rssamplifier.com/phoenix-fm', 'Phoenix FM');

  assert.deepEqual(Object.keys(types), [
    'application/rss+xml',
    'application/atom+xml',
    'application/feed+json',
    'text/markdown',
  ]);
  assert.equal(types['application/rss+xml'][0].url, 'https://rssamplifier.com/phoenix-fm.rss');
  assert.equal(types['text/markdown'][0].url, 'https://rssamplifier.com/phoenix-fm.md');
});

test('a query survives into the feed a page announces', () => {
  // The search page's identity is its query, so an alternate without one points
  // at a 400 rather than at the search the reader just ran.
  const types = feedAlternates('/search', 'lisp', '?q=lisp&kind=podcasts');

  assert.equal(types['application/rss+xml'][0].url, '/search.rss?q=lisp&kind=podcasts');
});

test('no playlist is ever autodiscovered as a subscription', () => {
  // A reader handed an .m3u where it expected a feed reports a broken
  // subscription. Playlists are linked where the media exists, never announced.
  assert.ok(!SUBSCRIBE_FORMATS.includes('m3u'));
  assert.ok(!SUBSCRIBE_FORMATS.includes('pls'));
  // .xml is the same document as .rss under a second name.
  assert.ok(!SUBSCRIBE_FORMATS.includes('xml'));
});

test('markdown is described as something to read, not to poll', () => {
  assert.match(formatTitle('md', 'this blog'), /document to read/);
  assert.match(formatTitle('rss', 'this blog'), /recent posts/);
});

test('every announced format is actually routed', () => {
  // next.config.mjs cannot import these lists — it is evaluated before the
  // workspace resolves — so the extensions are written out there. Announcing a
  // format the rewrite does not carry would ship a <link rel="alternate">
  // pointing at a 404, which a feed reader reports as the *feed* being broken.
  // Anchored on the opening quote, so this finds the root-level rule rather
  // than the /topics/:slug one that appears earlier in the file.
  const rule = /'\/:slug\.:format\(([a-z0-9|]+)\)/.exec(config);
  assert.ok(rule, 'no per-feed syndication rewrite found in next.config.mjs');

  for (const ext of SUBSCRIBE_FORMATS) {
    assert.ok(rule[1].split('|').includes(ext), `${ext} is announced but not routed`);
  }
});

test('the category rewrite lists exactly the category pages that exist', () => {
  // Two `:kind(...)` rules now: the playlist one, written first because it has
  // to be matched first, and the documents one. Found by the formats each
  // carries rather than by position, so reordering the file cannot silently
  // make this assert about the wrong rule.
  const rules = [...config.matchAll(/\/:kind\(([a-z|]+)\)\.:format\(([a-z0-9|]+)\)/g)];
  const documents = rules.find(([, , formats]) => formats.includes('rss'));
  assert.ok(documents, 'no category syndication rewrite found in next.config.mjs');

  assert.deepEqual(documents[1].split('|').sort(), [...CATEGORY_SEGMENTS.keys()].sort());
});

test('only the categories that publish their entries are routed as playlists', () => {
  // An `.m3u` of a category that lists *feeds* would be an empty file: a
  // directory entry has nothing to play. So the playlist rule must cover the
  // river categories and no others, and directoryRiver refuses the rest by
  // hand — both halves, because the rewrite is what decides whether the
  // request reaches the handler at all.
  const rules = [...config.matchAll(/\/:kind\(([a-z|]+)\)\.:format\(([a-z0-9|]+)\)/g)];
  const playlists = rules.find(([, , formats]) => formats.includes('m3u'));
  assert.ok(playlists, 'no category playlist rewrite found in next.config.mjs');

  const rivers = Object.values(CATEGORIES)
    .filter((category) => category.river)
    .map((category) => category.path.replace(/^\//, ''));

  assert.ok(rivers.length > 0, 'no category is marked river, so this rule should not exist');
  assert.deepEqual(playlists[1].split('|').sort(), rivers.sort());
});

test('the catch-all feed rule is written after every fixed address', () => {
  // `/:slug.:format` matches /feed.rss, /blogs.rss and /search.rss too. Next
  // takes the first rewrite that matches, so the order in the file is the only
  // thing keeping the directory's own feeds from being looked up as feed slugs.
  const catchAll = config.indexOf("'/:slug.:format(");

  for (const fixed of ["'/feed.:format(", "'/:kind(", "'/search.:format(", "'/authors/:slug.:format("]) {
    const at = config.indexOf(fixed);
    assert.ok(at > -1, `${fixed} is missing from next.config.mjs`);
    assert.ok(at < catchAll, `${fixed} must be listed before the catch-all`);
  }
});
