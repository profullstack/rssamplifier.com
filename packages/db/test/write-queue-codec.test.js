import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeResult,
  decodeStatement,
  encodeResult,
  encodeStatement,
} from '../src/writeQueue.js';

/**
 * The codec is the risky half of moving writes onto a queue.
 *
 * Everything else fails loudly — a broken connection throws, a missing worker
 * times out. A codec that quietly turns a BigInt id into a Number, or drops a
 * blob, writes the *wrong row* and says it succeeded. So these tests are about
 * the types that do not survive JSON, not about the happy path.
 */

test('a statement survives the round trip unchanged', () => {
  const stmt = { sql: 'insert into feeds (id, title) values (?, ?)', args: ['abc', 'A Blog'] };
  assert.deepEqual(decodeStatement(encodeStatement(stmt)), stmt);
});

test('a bare SQL string is a statement too', () => {
  // `db.batch(['select 1'])` is legal libSQL and appears in this codebase.
  assert.deepEqual(decodeStatement(encodeStatement('vacuum')), { sql: 'vacuum', args: [] });
});

test('a BigInt argument stays a BigInt, rather than becoming a Number', () => {
  // The one that would be silent. SQLite integers arrive as BigInt once they
  // exceed the safe range, and JSON.stringify throws on them outright — so the
  // failure mode of getting this wrong is either a crash or, worse, a coerced
  // id that writes against the wrong row.
  const stmt = { sql: 'update feeds set n = ? where id = ?', args: [9007199254740993n, 'x'] };
  const back = decodeStatement(encodeStatement(stmt));

  assert.equal(typeof back.args[0], 'bigint');
  assert.equal(back.args[0], 9007199254740993n);
});

test('a blob argument stays bytes', () => {
  const bytes = new Uint8Array([0, 1, 250, 255]);
  const back = decodeStatement(encodeStatement({ sql: 'insert into x values (?)', args: [bytes] }));

  assert.ok(back.args[0] instanceof Uint8Array);
  assert.deepEqual(Array.from(back.args[0]), [0, 1, 250, 255]);
});

test('named arguments survive as named arguments', () => {
  const stmt = { sql: 'select :a', args: { a: 1, b: 2n } };
  const back = decodeStatement(encodeStatement(stmt));

  assert.equal(back.args.a, 1);
  assert.equal(back.args.b, 2n);
});

test('null and undefined arguments do not become the string "null"', () => {
  const back = decodeStatement(encodeStatement({ sql: 'x', args: [null, 0, '', false] }));
  assert.deepEqual(back.args, [null, 0, '', false]);
});

test('a result carries back the two things callers actually read', () => {
  // `rowsAffected` is reduced over by several queries; `rows` is read by
  // storeCrawl for its RETURNING clause. Both must cross intact or a crawl
  // silently reports storing nothing.
  const result = {
    rowsAffected: 3,
    lastInsertRowid: 42n,
    columns: ['id', 'n'],
    rows: [{ id: 'a', n: 1 }],
  };

  const back = decodeResult(encodeResult(result));
  assert.equal(back.rowsAffected, 3);
  assert.equal(back.lastInsertRowid, 42n);
  assert.deepEqual(back.rows, [{ id: 'a', n: 1 }]);
});

test('a result row keeps a BigInt column as a BigInt', () => {
  const back = decodeResult(encodeResult({ rowsAffected: 0, rows: [{ big: 12345678901234567n }] }));
  assert.equal(back.rows[0].big, 12345678901234567n);
});

test('an empty result set is zero rows affected, not undefined', () => {
  // Callers do `results.reduce((n, r) => n + Number(r.rowsAffected ?? 0), 0)`,
  // and NaN propagating through that would report a successful write as
  // having done nothing measurable.
  const back = decodeResult(encodeResult({}));
  assert.equal(back.rowsAffected, 0);
  assert.deepEqual(back.rows, []);
  assert.ok(Number.isFinite(Number(back.rowsAffected)));
});

test('the encoded form is actually JSON-serialisable', () => {
  // The whole point: this is what goes into Redis. A BigInt anywhere in here
  // makes JSON.stringify throw at enqueue time, in production, on a write.
  const encoded = encodeStatement({
    sql: 'insert into x values (?, ?, ?)',
    args: [1n, new Uint8Array([1, 2]), 'plain'],
  });

  assert.doesNotThrow(() => JSON.stringify(encoded));
  assert.deepEqual(decodeStatement(JSON.parse(JSON.stringify(encoded))).args[0], 1n);
});
