#!/usr/bin/env node
/**
 * Bulk-load a feed catalogue straight into the directory's database.
 *
 * Deliberately not part of the public API: the HTTP submit endpoint resolves
 * every URL over the network before storing it, which is the right behaviour
 * for a person pasting a link and the wrong one for a 47,000-entry OPML. This
 * writes the rows as `pending` and lets the poller discover the real metadata.
 *
 * Usage
 *   node scripts/import-catalogue.js <file.opml|file.txt> [--spread-minutes N] [--dry-run]
 *
 * A .txt file is read as one feed URL per line; anything else is parsed as OPML.
 * Credentials come from TURSO_DATABASE_URL / TURSO_AUTH_TOKEN, so run it with
 * `node --env-file=.env`.
 */

import { readFile } from 'node:fs/promises';

import { connect, q } from '@rssamplifier/db';
import { parseOpml } from '@rssamplifier/feed';
import { importFeeds } from '@rssamplifier/ingest';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const dryRun = argv.includes('--dry-run');
const spreadArg = argv.indexOf('--spread-minutes');
const spreadMinutes = spreadArg === -1 ? undefined : Number(argv[spreadArg + 1]);

if (!file) {
  console.error('usage: import-catalogue.js <file.opml|file.txt> [--spread-minutes N] [--dry-run]');
  process.exit(1);
}

const raw = await readFile(file, 'utf8');

const entries = file.endsWith('.txt')
  ? raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((url) => ({ url, title: '' }))
  : parseOpml(raw);

console.error(`parsed ${entries.length} feeds from ${file}`);

if (dryRun) {
  console.error(JSON.stringify(entries.slice(0, 3), null, 2));
  process.exit(0);
}

const db = connect();
const before = await q.countFeeds(db, true);

const result = await importFeeds(db, entries, {
  spreadMinutes,
  onProgress: ({ inserted, seen, total }) => {
    process.stderr.write(`\rinserted ${inserted} / seen ${seen} of ${total}`);
  },
});

const after = await q.countFeeds(db, true);
process.stderr.write('\n');
console.log(JSON.stringify({ ...result, feedsBefore: before, feedsAfter: after }, null, 2));
