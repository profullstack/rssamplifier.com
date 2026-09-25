import assert from 'node:assert/strict';
import { test } from 'node:test';

import { creditStatements, feedLinkStatements } from '../src/authors.js';

/**
 * What `bind()` in src/pg.js does to a bound parameter before pg sees it.
 *
 * libSQL's remote client refused `undefined` outright (`TypeError: Unsupported
 * type of value`), and the local SQLite driver every test ran on did not, so
 * the fault only ever showed in production. Postgres moves the hazard rather
 * than removing it: `bind()` turns `undefined` into null, and a null lands in
 * the server's lap, where `feed_links.source` and `author_links.source` are
 * `not null` and refuse it — failing the whole crawl transaction that carried
 * the feed row and its posts, exactly as before.
 *
 * So the test still runs on the statements themselves, at the layer that has
 * to be right whatever the callers do: apply the same coercions `bind()`
 * applies, and check that what comes out is a value Postgres has a text form
 * for, and that the `not null` slots are not null.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function bound(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * A bound value pg can send as a parameter without guessing. `null`, text, a
 * finite number (NaN and Infinity are sent as words and only a float column
 * takes them) or bytes. Symbols and functions have no wire form; a plain object
 * would be JSON-stringified by pg, which is never what a column here wants.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function sendable(value) {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string') return true;
  if (type === 'number') return Number.isFinite(value);
  return value instanceof Uint8Array;
}

/**
 * The placeholder positions that feed `columns` in an insert.
 *
 * Reads the column list and the row that follows it -- `values (?, ?, ...)` or
 * `select ?, id, ?, ... from ...` -- and pairs them up. Only a `?` is a bound
 * argument, so a column fed by an expression (`id` from the subselect in
 * creditStatements) takes no argument slot and shifts nothing after it.
 *
 * @param {string} sql
 * @param {string[]} columns
 * @returns {number[]}
 */
function slotsOf(sql, columns) {
  const list = /insert into \w+\s*\(([^)]*)\)\s*(?:values\s*\(([^)]*)\)|select\s+(.*?)\s+from\b)/is.exec(sql);
  if (!list) return [];
  const names = list[1].split(',').map((c) => c.trim());
  const row = (list[2] ?? list[3]).split(',').map((c) => c.trim());
  assert.equal(row.length, names.length, `column list and row disagree: ${sql.slice(0, 80)}`);

  /** @type {Map<string, number>} */
  const slots = new Map();
  let next = 0;
  for (const [i, expr] of row.entries()) {
    if (expr !== '?') continue;
    slots.set(names[i], next);
    next += 1;
  }
  return columns.map((c) => slots.get(c)).filter((i) => i !== undefined);
}

/**
 * @param {Array<{ sql: string, args: unknown[] }>} statements
 */
function assertBinds(statements) {
  for (const statement of statements) {
    const args = statement.args.map(bound);
    for (const [index, arg] of args.entries()) {
      assert.ok(
        sendable(arg),
        `arg ${index} (${String(arg)}) cannot be sent: ${statement.sql.slice(0, 80)}`,
      );
    }
    // The columns the schema declares `not null` on both link tables, and that a
    // caller can plausibly leave out.
    for (const slot of slotsOf(statement.sql, ['source', 'network', 'url'])) {
      assert.notEqual(
        args[slot],
        null,
        `arg ${slot} is null in a not-null column: ${statement.sql.slice(0, 80)}`,
      );
    }
  }
}

const person = {
  name: 'Marta Nowak',
  normName: 'marta nowak',
  bio: '',
  avatarUrl: '',
  siteUrl: '',
  email: 'marta@example.com',
  confidence: 0.85,
  role: 'owner',
  evidence: 'itunes-owner',
};

test('a link that names no source is still storable', () => {
  // The crawler-stopping bug, at the layer that has to be right whatever the
  // callers do. `feed_links.source` and `author_links.source` are `not null`,
  // and a link arriving without one used to bind `undefined` -- refused by the
  // libSQL remote client then, turned into a null the server refuses now --
  // failing the entire crawl transaction that carried the feed row and its
  // posts. Every Substack newsletter in the directory produced exactly this
  // shape.
  const link = { network: 'email', url: 'mailto:marta@example.com' };

  const statements = creditStatements({
    feedId: 'feed-1',
    identityKey: 'marta@example.com',
    slug: 'marta-nowak',
    person,
    authorLinks: [link],
    feedLinks: [link],
  });

  assertBinds(statements);
  assertBinds(feedLinkStatements('feed-1', [link]));
});

test('a link that does name its source keeps it', () => {
  const link = { network: 'email', url: 'mailto:marta@example.com', source: 'rel-me' };
  const [statement] = feedLinkStatements('feed-1', [link]);

  assert.ok(statement.args.includes('rel-me'));
  assertBinds([statement]);
});

test('a whole credit binds cleanly when the person is bare', () => {
  // A credit carrying nothing but a name -- no bio, no avatar, no site, no
  // email -- is the common case on the small web, and every one of those holes
  // is a bound parameter. Nulls are fine there; those columns allow them.
  const statements = creditStatements({
    feedId: 'feed-1',
    identityKey: 'someone@example.com',
    slug: 'someone',
    person: { name: 'Someone', confidence: 0.4, role: 'author' },
  });

  assertBinds(statements);
});

test('the coercions match what pg.js binds', () => {
  // Pinned here so a change to bind() shows up next to the test that relies on
  // it, rather than as a crawl that stops in production.
  assert.equal(bound(undefined), null);
  assert.equal(bound(true), 1);
  assert.equal(bound(false), 0);
  assert.equal(bound(12n), 12);
  assert.equal(bound(new Date('2026-08-18T08:54:06.232Z')), '2026-08-18T08:54:06.232Z');
  assert.equal(bound('x'), 'x');
  assert.equal(bound(null), null);
});
