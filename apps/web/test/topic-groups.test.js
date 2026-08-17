import assert from 'node:assert/strict';
import { test } from 'node:test';

import { q } from '@rssamplifier/db';

import { CATEGORIES } from '../src/lib/categories.js';
import { TOPIC_GROUPS, groupsWithFeeds, slugFromUrl, topicGroup } from '../src/lib/topicGroups.js';

test('every category the directory browses by is a sub-group a topic can be cut into', () => {
  const covered = new Set(TOPIC_GROUPS.flatMap((group) => group.kinds));
  for (const kind of q.KINDS) {
    assert.ok(covered.has(kind), `${kind} has no topic sub-group`);
  }
});

test("a sub-group's segment is the category page's own name", () => {
  // /topics/physics/videos sits under /videos. If these ever disagree the site
  // has two vocabularies for one idea, which is the thing this table exists to
  // prevent.
  for (const kind of q.KINDS) {
    const group = TOPIC_GROUPS.find((g) => g.kinds.length === 1 && g.kinds[0] === kind);
    assert.equal(`/${group.segment}`, CATEGORIES[kind].path);
  }
});

test('audio is podcasts and music, and sits with them', () => {
  const audio = topicGroup('audio');
  assert.deepEqual(audio.kinds, ['podcast', 'music']);

  const segments = TOPIC_GROUPS.map((g) => g.segment);
  assert.equal(segments.indexOf('audio'), segments.indexOf('music') + 1);
});

test('a segment is matched whatever case it was typed in', () => {
  assert.equal(topicGroup('PODCASTS')?.segment, 'podcasts');
  assert.equal(topicGroup('podcasts')?.segment, 'podcasts');
});

test('a segment that is not a category is nothing, not a guess', () => {
  assert.equal(topicGroup('elephants'), null);
  assert.equal(topicGroup(''), null);
  assert.equal(topicGroup(undefined), null);
  // Singular is a plausible typo and still wrong: the pages are plural, and
  // answering both would put every listing at two addresses.
  assert.equal(topicGroup('blog'), null);
});

test('playlists are only offered where the entries are files', () => {
  assert.equal(topicGroup('podcasts').playlists, true);
  assert.equal(topicGroup('music').playlists, true);
  assert.equal(topicGroup('audio').playlists, true);
  assert.equal(topicGroup('lives').playlists, true);
  // An .m3u of a topic's writing is an empty playlist.
  assert.equal(topicGroup('blogs').playlists, false);
  assert.equal(topicGroup('comics').playlists, false);
  // And an .m3u of a topic's videos is a broken one: YouTube's enclosure is an
  // embed page and PeerTube's a download endpoint that stops resolving.
  assert.equal(topicGroup('videos').playlists, false);
  assert.equal(topicGroup('reels').playlists, false);
});

test('the browser can play more than a playlist file can carry', () => {
  // Everything with a playlist plays here too.
  assert.equal(topicGroup('podcasts').player, true);
  assert.equal(topicGroup('audio').player, true);
  assert.equal(topicGroup('lives').player, true);
  // ...and videos, which is the whole gap between the two questions: they play
  // in the docked player and cannot be written to a playlist file at all.
  assert.equal(topicGroup('videos').player, true);
  assert.equal(topicGroup('reels').player, true);
  // Writing is still writing.
  assert.equal(topicGroup('blogs').player, false);
  assert.equal(topicGroup('comics').player, false);
});

test('a watch group is the one whose playlist docks instead of playing in the page', () => {
  assert.equal(topicGroup('videos').watch, true);
  assert.equal(topicGroup('reels').watch, true);
  assert.equal(topicGroup('podcasts').watch, false);
  assert.equal(topicGroup('audio').watch, false);
});

test('only the groups a topic actually has are offered', () => {
  const offered = groupsWithFeeds({ blog: 12, podcast: 3, comic: 0 });

  assert.deepEqual(
    offered.map((entry) => [entry.group.segment, entry.count]),
    [
      ['blogs', 12],
      ['podcasts', 3],
      ['audio', 3],
    ],
  );
});

test('a composite group counts every kind in it', () => {
  const audio = groupsWithFeeds({ podcast: 4, music: 7 }).find((e) => e.group.segment === 'audio');
  assert.equal(audio.count, 11);
});

test('a topic with nothing in it offers no groups at all', () => {
  assert.deepEqual(groupsWithFeeds({}), []);
});

test('a keyword is normalised however it arrived in the URL', () => {
  assert.equal(slugFromUrl('Home%20Lab'), slugFromUrl('home-lab'));
  assert.equal(slugFromUrl('home lab'), slugFromUrl('home-lab'));
  assert.equal(slugFromUrl(''), '');
});

test('a set of kinds keeps the real ones and drops the rest', () => {
  assert.deepEqual(q.normalizeKinds(['blog', 'podcast']), ['blog', 'podcast']);
  assert.deepEqual(q.normalizeKinds('blog'), ['blog']);
  assert.deepEqual(q.normalizeKinds(['blog', 'blog']), ['blog']);
  // Nothing usable means "every kind", the same as asking for no filter — so a
  // caller that guessed a category name sees the whole topic rather than a page
  // that looks empty for no stated reason.
  assert.equal(q.normalizeKinds(['elephant']), null);
  assert.equal(q.normalizeKinds([]), null);
  assert.equal(q.normalizeKinds(undefined), null);
});
