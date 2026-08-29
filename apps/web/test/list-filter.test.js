import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FILTER_FROM, matches, normalise, terms } from '../src/lib/listFilter.js';

/** How a row reaches the filter: the whole of its text, newlines and all. */
const row = (s) => normalise(s);

const hits = (rows, query) => rows.filter((r) => matches(normalise(r), terms(query)));

test('a row matches on any part of its text, not just its title', () => {
  const haystack = row('Bean Notes\nA small blog about coffee, roasting.\nexample.com 20 posts');

  assert.ok(matches(haystack, terms('bean')));
  assert.ok(matches(haystack, terms('roasting')), 'the description counts');
  assert.ok(matches(haystack, terms('example.com')), 'so does the meta line');
});

test('every word has to appear, in any order', () => {
  const haystack = row('Async Rust Notes — concurrency, one page at a time');

  assert.ok(matches(haystack, terms('rust async')), 'order does not matter');
  assert.ok(matches(haystack, terms('async concurrency')));
  assert.ok(!matches(haystack, terms('async python')), 'one miss is a miss');
});

test('a partial word matches, because people type the stem', () => {
  const haystack = row('The Gardening Log');

  assert.ok(matches(haystack, terms('garden')));
  assert.ok(matches(haystack, terms('ing log')));
});

test('an accent is not something anyone should have to type', () => {
  assert.ok(matches(row('Café Review'), terms('cafe')));
  assert.ok(matches(row('Cafe Review'), terms('café')), 'and it works the other way round');
  assert.ok(matches(row('Über Alles'), terms('uber')));
});

test('an empty box matches everything', () => {
  const rows = ['Rust Systems Weekly', 'Python Daily', 'Tomato Diary'];

  assert.equal(hits(rows, '').length, 3);
  assert.equal(hits(rows, '   ').length, 3, 'and so does a box holding only spaces');
});

test('a row whose markup wraps its words across lines still matches the phrase', () => {
  // The rows are real markup: a title in an h3 and a description in a p arrive
  // as textContent with newlines between them, so "notes small" spans two
  // elements and a naive match on the raw string would miss it.
  const haystack = row('Bean\n  Notes\n\n  A small blog');

  assert.equal(haystack, 'bean notes a small blog');
  assert.ok(matches(haystack, terms('notes small')));
});

test('narrowing is what the filter does — it cannot widen a page', () => {
  const rows = ['Coffee Notes', 'Roast Profile', 'Chess Endgames'];

  assert.equal(hits(rows, 'co').length, 1);
  assert.equal(hits(rows, 'nothing here').length, 0, 'a miss hides everything, which is honest');
});

test('the threshold is a number a server component can compare against', () => {
  // The point of the constant living in lib rather than in the client
  // component: read from a client module, a server component gets a reference
  // rather than a value, and `rows.length >= FILTER_FROM` is then always false.
  assert.equal(typeof FILTER_FROM, 'number');
  assert.ok(FILTER_FROM > 1);
});
