import test from 'node:test';
import assert from 'node:assert/strict';

import { clusterKey, dedupeItems, titleWords } from '../index.js';

test('the same headline from two feeds gets the same key', () => {
  const a = clusterKey('Rust 2.0 has been released today');
  const b = clusterKey('Rust 2.0 has been released today');
  assert.equal(a, b);
  assert.ok(a);
});

test('word order does not change the key', () => {
  assert.equal(
    clusterKey('Rust 2.0 released to general availability'),
    clusterKey('Released to general availability: Rust 2.0'),
  );
});

test('punctuation and case do not change the key', () => {
  assert.equal(
    clusterKey('The Fall of the Roman Empire!'),
    clusterKey('the fall of  the ROMAN empire'),
  );
});

test('different stories do not collide', () => {
  assert.notEqual(
    clusterKey('How to build a woodshed that stays dry'),
    clusterKey('How to build a canoe that stays afloat'),
  );
});

test('short and generic titles are never grouped', () => {
  // The whole small web would otherwise merge into one post.
  for (const t of ['Weeknotes', 'Links', 'Monthly update', 'Hello world', '']) {
    assert.equal(clusterKey(t), null, `expected no key for ${JSON.stringify(t)}`);
  }
});

test('a non-latin headline still produces a key', () => {
  const key = clusterKey('Ρυθμίσεις για την ενεργειακή απόδοση κτιρίων');
  assert.ok(key, 'a Greek headline must not reduce to nothing');
});

test('stopwords alone cannot make a title groupable', () => {
  assert.equal(clusterKey('It is what it is'), null);
});

test('titleWords drops grammar and keeps substance', () => {
  assert.deepEqual(titleWords('The fall of the Roman Empire'), ['fall', 'roman', 'empire']);
});

test('dedupe keeps the first telling and counts the rest', () => {
  const rows = [
    { title: 'Rust 2.0 has been released today', feed: 'a' },
    { title: 'Rust 2.0 has been released today', feed: 'b' },
    { title: 'Rust 2.0 has been released today', feed: 'c' },
    { title: 'Something else entirely happened here', feed: 'd' },
  ];

  const out = dedupeItems(rows);

  assert.equal(out.length, 2);
  assert.equal(out[0].feed, 'a');
  assert.equal(out[0].duplicates, 2);
  assert.equal(out[1].duplicates, 0);
});

test('dedupe never merges items that have no key', () => {
  const rows = [
    { title: 'Weeknotes', feed: 'a' },
    { title: 'Weeknotes', feed: 'b' },
    { title: 'Weeknotes', feed: 'c' },
  ];

  assert.equal(dedupeItems(rows).length, 3);
});

test('dedupe prefers a stored key over recomputing it', () => {
  const rows = [
    { title: 'One wording of the same story', cluster_key: 'shared' },
    { title: 'A different wording of that story', cluster_key: 'shared' },
  ];

  const out = dedupeItems(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].duplicates, 1);
});

test('dedupe falls back to the title when the column is not backfilled', () => {
  const rows = [
    { title: 'Rust 2.0 has been released today', cluster_key: null },
    { title: 'Rust 2.0 has been released today', cluster_key: null },
  ];

  assert.equal(dedupeItems(rows).length, 1);
});

test('an empty list is not an error', () => {
  assert.deepEqual(dedupeItems([]), []);
  assert.deepEqual(dedupeItems(undefined), []);
});
