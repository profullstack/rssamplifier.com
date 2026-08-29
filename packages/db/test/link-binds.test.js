import assert from 'node:assert/strict';
import { test } from 'node:test';

import { creditStatements, feedLinkStatements } from '../src/authors.js';

/**
 * Everything the remote libSQL client will accept as a bound parameter.
 *
 * Mirrors `valueToProto` in @libsql/hrana-client: null, string, finite number,
 * bigint, boolean, ArrayBuffer, Uint8Array, Date and any other object (which is
 * stringified). What is left -- `undefined`, symbols and functions -- throws
 * `TypeError: Unsupported type of value` during serialization.
 *
 * This is asserted here rather than left to an integration test because the
 * local SQLite driver used by every test in this repo does *not* share the
 * restriction: it binds `undefined` as null and passes. The only place the
 * difference shows up is production.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function bindable(value) {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'undefined' || type === 'symbol' || type === 'function') return false;
  if (type === 'number') return Number.isFinite(value);
  return true;
}

/**
 * @param {Array<{ sql: string, args: unknown[] }>} statements
 */
function assertBindable(statements) {
  for (const statement of statements) {
    for (const [index, arg] of statement.args.entries()) {
      assert.ok(
        bindable(arg),
        `arg ${index} (${String(arg)}) cannot be bound: ${statement.sql.slice(0, 80)}`,
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
  // and a link arriving without one used to bind `undefined` -- which the
  // remote client refuses outright, failing the entire crawl transaction that
  // carried the feed row and its posts. Every Substack newsletter in the
  // directory produced exactly this shape.
  const link = { network: 'email', url: 'mailto:marta@example.com' };

  const statements = creditStatements({
    feedId: 'feed-1',
    identityKey: 'marta@example.com',
    slug: 'marta-nowak',
    person,
    authorLinks: [link],
    feedLinks: [link],
  });

  assertBindable(statements);
  assertBindable(feedLinkStatements('feed-1', [link]));
});

test('a link that does name its source keeps it', () => {
  const link = { network: 'email', url: 'mailto:marta@example.com', source: 'rel-me' };
  const [statement] = feedLinkStatements('feed-1', [link]);

  assert.ok(statement.args.includes('rel-me'));
  assertBindable([statement]);
});

test('a whole credit binds cleanly when the person is bare', () => {
  // A credit carrying nothing but a name -- no bio, no avatar, no site, no
  // email -- is the common case on the small web, and every one of those holes
  // is a bound parameter.
  const statements = creditStatements({
    feedId: 'feed-1',
    identityKey: 'someone@example.com',
    slug: 'someone',
    person: { name: 'Someone', confidence: 0.4, role: 'author' },
  });

  assertBindable(statements);
});
