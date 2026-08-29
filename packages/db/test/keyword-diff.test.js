import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keywordDiffStatements, keywordStatements } from '../src/queries.js';
import { statementShape } from '../src/writeQueue.js';

const stored = [
  { slug: 'rust', keyword: 'rust', words: 1, count: 12, source: 'content' },
  { slug: 'homelab', keyword: 'homelab', words: 1, count: 4, source: 'category' },
];

test('a re-crawl that changed nothing writes nothing', () => {
  // The whole point. This is the common case on a re-crawl — the feed still
  // covers the topics it covered — and a full replace wrote every row back to
  // the value it already held. ~945,000 rows a day of it.
  const out = keywordDiffStatements('f1', stored, stored);
  assert.deepEqual(out, []);
});

test('a full replace would have written every row for that same no-op', () => {
  // The comparison the fix is against: one delete plus one insert per topic,
  // regardless of whether anything differs.
  const replace = keywordStatements('f1', stored);
  assert.equal(replace.length, 3, 'one delete plus two inserts');
  assert.match(replace[0].sql, /^delete from feed_keywords where feed_id = \?$/);
});

test('a topic the feed stopped writing about is deleted, and only that one', () => {
  const out = keywordDiffStatements('f1', [stored[0]], stored);
  assert.equal(out.length, 1);
  assert.match(out[0].sql, /^delete from feed_keywords where feed_id = \? and slug = \?$/);
  assert.deepEqual(out[0].args, ['f1', 'homelab']);
});

test('a new topic is inserted, and the unchanged ones are left alone', () => {
  const out = keywordDiffStatements(
    'f1',
    [...stored, { slug: 'sqlite', keyword: 'sqlite', words: 1, count: 3 }],
    stored,
  );
  assert.equal(out.length, 1, 'only the new one is written');
  assert.match(out[0].sql, /insert into feed_keywords/);
  assert.deepEqual(out[0].args, ['f1', 'sqlite', 'sqlite', 1, 3, 'content']);
});

test('a drifted count is updated rather than deleted and reinserted', () => {
  // `count` orders the feeds inside a topic page, so it has to keep tracking —
  // this is why the comparison is on every column and not just the slug.
  const out = keywordDiffStatements(
    'f1',
    [{ ...stored[0], count: 30 }, stored[1]],
    stored,
  );
  assert.equal(out.length, 1);
  assert.match(out[0].sql, /^update feed_keywords set/);
  assert.deepEqual(out[0].args, ['rust', 1, 30, 'content', 'f1', 'rust']);
});

test('a change of source is a change, because it reorders the topic page', () => {
  const out = keywordDiffStatements('f1', [{ ...stored[0], source: 'category' }, stored[1]], stored);
  assert.equal(out.length, 1);
  assert.match(out[0].sql, /^update feed_keywords set/);
});

test('a first extraction inserts everything, since nothing is stored', () => {
  const out = keywordDiffStatements('f1', stored, []);
  assert.equal(out.length, 2);
  assert.ok(out.every((s) => /insert into feed_keywords/.test(s.sql)));
});

test('extracting nothing clears what was there', () => {
  const out = keywordDiffStatements('f1', [], stored);
  assert.equal(out.length, 2);
  assert.ok(out.every((s) => /^delete from feed_keywords/.test(s.sql)));
});

test('a keyword with no slug is ignored rather than written as null', () => {
  const out = keywordDiffStatements('f1', [{ keyword: 'x' }], []);
  assert.deepEqual(out, []);
});

test('statement shapes collapse a million crawls into one line', () => {
  assert.equal(statementShape({ sql: 'insert into feed_items (a,b) values (?,?)' }), 'insert feed_items');
  assert.equal(statementShape({ sql: '  UPDATE   feeds SET x = ?  ' }), 'update feeds');
  assert.equal(statementShape({ sql: 'delete from feed_keywords where feed_id = ?' }), 'delete feed_keywords');
  assert.equal(statementShape('insert or replace into topics values (?)'), 'insert topics');
  // Two crawls of different feeds must land on the same key, or the tally is a
  // list of every statement ever run rather than a summary.
  assert.equal(
    statementShape({ sql: 'update feeds set a = ? -- one' }),
    statementShape({ sql: 'update feeds set a = ?\n-- two' }),
  );
});
