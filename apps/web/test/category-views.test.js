import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CATEGORIES, listHref, viewName } from '../src/lib/categories.js';

/**
 * The two ways to look at a category, and the URLs that address them.
 *
 * A category page used to have one question in it — who is in this directory —
 * and /podcasts now leads with the other one: what has just come out, across
 * every show at once. Both are real addresses, because the directory of feeds
 * is what every feed page links back from and a crawler has to be able to
 * reach it.
 */

test('a river category defaults to its entries and can be asked for its feeds', () => {
  assert.equal(viewName(undefined, CATEGORIES.podcast), 'latest');
  assert.equal(viewName('', CATEGORIES.podcast), 'latest');
  assert.equal(viewName('shows', CATEGORIES.podcast), 'shows');
});

test('a category that does not publish a river is always its list of feeds', () => {
  // Asking for the river on /blogs is not an error, it is the page it was
  // always going to be: three hundred thousand blogs have no affordable
  // "newest post across all of them", which is the whole reason `river` is a
  // per-category flag rather than the default.
  assert.equal(viewName('latest', CATEGORIES.blog), 'shows');
  assert.equal(viewName('shows', CATEGORIES.blog), 'shows');
  assert.equal(viewName(undefined, {}), 'shows');
});

test('an unreadable view is the default rather than an error', () => {
  // Same reasoning as pageNumber: this is a parameter in a URL people edit,
  // share and guess at.
  assert.equal(viewName('LATEST', CATEGORIES.podcast), 'latest');
  assert.equal(viewName('nonsense', CATEGORIES.podcast), 'latest');
  assert.equal(viewName(null, CATEGORIES.podcast), 'latest');
});

test('a repeated view parameter takes the first spelling', () => {
  // Next hands a repeated parameter over as an array, and `String(['a','b'])`
  // is "a,b" — which matches nothing and would quietly become the default.
  assert.equal(viewName(['shows'], CATEGORIES.podcast), 'shows');
  assert.equal(viewName(['SHOWS'], CATEGORIES.podcast), 'shows');
  assert.equal(viewName(['shows', 'latest'], CATEGORIES.podcast), 'shows');
  assert.equal(viewName([], CATEGORIES.podcast), 'latest');
});

test('page one of the default view is the bare path', () => {
  // Two URLs for one listing is a duplicate-content signal to the crawlers
  // this directory exists for.
  assert.equal(listHref('/podcasts', 'latest', 1), '/podcasts');
  assert.equal(listHref('/podcasts', 'latest', 0), '/podcasts');
});

test('the view and the page both survive into the link', () => {
  assert.equal(listHref('/podcasts', 'latest', 2), '/podcasts?page=2');
  assert.equal(listHref('/podcasts', 'shows', 1), '/podcasts?view=shows');
  assert.equal(listHref('/podcasts', 'shows', 3), '/podcasts?view=shows&page=3');
});

test('podcasts is the category that leads with its episodes', () => {
  // The flag is what turns the river on, in the page, in the feed and in the
  // playlist rewrite. If it ever moves, all three move together — which is
  // what this asserts is still true of the one category that has it.
  assert.equal(CATEGORIES.podcast.river, true);
  assert.equal(CATEGORIES.podcast.entrySchemaType, 'PodcastEpisode');

  const rivers = Object.keys(CATEGORIES).filter((kind) => CATEGORIES[kind].river);
  assert.deepEqual(rivers, ['podcast']);
});
