import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  followingFeedUrl,
  kindsAvailable,
  narrow,
  riverKinds,
} from '../src/lib/following.js';

/**
 * Narrowing one reader's river to a kind.
 *
 * The river merges blogs, topics and people into one list, and "show me the
 * podcasts" has to reach all three — a podcast can arrive by any of them. The
 * filter is therefore pushed into the queries rather than applied to the
 * merged result: sixty posts of which four are podcasts is not the same
 * document as the sixty newest podcasts, and only the second is what was
 * asked for.
 */

test('the directory is browsable by the words its readers use for it', () => {
  // `blog` is what the column says; RSS is what half the people with one call
  // the whole idea. A filter that 404s on its own readers' vocabulary looks
  // broken rather than strict.
  assert.deepEqual(riverKinds('rss'), ['blog']);
  assert.deepEqual(riverKinds('blogs'), ['blog']);
  assert.deepEqual(riverKinds('podcasts'), ['podcast']);
  assert.deepEqual(riverKinds('podcast'), ['podcast']);
  assert.deepEqual(riverKinds('videos'), ['video']);
  assert.deepEqual(riverKinds('VIDEO'), ['video']);
});

test('no filter, and an unreadable one, are both the whole river', () => {
  // Wrong in the safe direction: the reader sees more than they asked for
  // rather than an empty page they cannot explain.
  assert.equal(riverKinds(undefined), null);
  assert.equal(riverKinds(''), null);
  assert.equal(riverKinds('all'), null);
  assert.equal(riverKinds('nonsense'), null);
  assert.equal(riverKinds('  '), null);
});

test('a repeated parameter takes the first spelling rather than throwing', () => {
  assert.deepEqual(riverKinds(['podcast', 'video']), ['podcast']);
  assert.equal(riverKinds([]), null);
});

test('a source with no kind of its own takes the filter outright', () => {
  // A whole topic, or a followed person: either can carry anything, so the
  // filter is the only thing narrowing them.
  assert.deepEqual(narrow(null, ['podcast']), { kinds: ['podcast'], empty: false });
  assert.deepEqual(narrow([], ['podcast']), { kinds: ['podcast'], empty: false });
});

test('a source that names its kinds keeps only the overlap', () => {
  const audio = ['podcast', 'music'];

  assert.deepEqual(narrow(audio, ['podcast']), { kinds: ['podcast'], empty: false });
  assert.deepEqual(narrow(audio, null), { kinds: audio, empty: false });
});

test('no overlap is empty, and empty is not the same as unfiltered', () => {
  // The distinction this whole helper exists for: an empty list of kinds
  // normalises back to "every kind" down in the query layer, so a source with
  // nothing in common with the filter has to be skipped rather than queried.
  // Without this, filtering to videos would make a topic followed as blogs
  // contribute its blogs.
  assert.deepEqual(narrow(['blog'], ['video']), { kinds: [], empty: true });
  assert.equal(narrow(['blog', 'news'], ['podcast']).empty, true);
  assert.equal(narrow(['blog', 'news'], ['news']).empty, false);
});

test('the chips offered are the kinds this account actually follows', () => {
  // A chip that can only ever be empty reads as "you have no podcasts this
  // week" when the truth is "you follow no podcasts".
  const available = kindsAvailable({
    feeds: [{ category: 'podcast' }, { category: 'blog' }, { category: 'podcast' }],
    topics: [],
    authors: [],
  });

  assert.deepEqual(available, ['blog', 'podcast']);
});

test('a topic followed as one of its groups contributes that group’s kinds', () => {
  const available = kindsAvailable({
    feeds: [],
    topics: [{ slug: 'ai', segment: 'audio' }],
    authors: [],
  });

  // "audio" is podcasts and music together — the one group that is not a
  // single category — and the chips come back in the directory's own order
  // rather than the order they were found in.
  assert.deepEqual(available, ['podcast', 'music']);
});

test('a whole-topic follow or a followed person opens every kind', () => {
  // Neither knows what it carries until the river is read, so neither can be
  // used to rule a kind out.
  const byTopic = kindsAvailable({ feeds: [], topics: [{ slug: 'ai', segment: '' }], authors: [] });
  const byPerson = kindsAvailable({ feeds: [], topics: [], authors: [{ slug: 'ada' }] });

  assert.ok(byTopic.includes('comic'));
  assert.ok(byPerson.includes('comic'));
  assert.deepEqual(byTopic, byPerson);
});

test('following nothing offers no filters at all', () => {
  assert.deepEqual(kindsAvailable({}), []);
  assert.deepEqual(kindsAvailable({ feeds: [], topics: [], authors: [] }), []);
});

test('the personal feed URL carries the filter it was copied under', () => {
  // A reader who narrows to podcasts and then takes the feed away should get
  // the podcasts, not everything.
  assert.equal(
    followingFeedUrl('https://rssamplifier.com', 'tok', 'rss', ['podcast']),
    'https://rssamplifier.com/following.rss?t=tok&kind=podcast',
  );
  assert.equal(
    followingFeedUrl('https://rssamplifier.com', 'tok', 'rss'),
    'https://rssamplifier.com/following.rss?t=tok',
  );
  assert.equal(
    followingFeedUrl('https://rssamplifier.com', 'tok', 'json', null),
    'https://rssamplifier.com/following.json?t=tok',
  );
});

test('a token that needs escaping still escapes', () => {
  assert.equal(
    followingFeedUrl('https://rssamplifier.com', 'a b+c', 'rss'),
    'https://rssamplifier.com/following.rss?t=a+b%2Bc',
  );
});
