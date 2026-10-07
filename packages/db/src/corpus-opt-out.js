#!/usr/bin/env node
/**
 * Keep a publisher in the directory but out of the corpus, at their request.
 *
 *   node packages/db/src/corpus-opt-out.js <slug | feed-url>
 *   node packages/db/src/corpus-opt-out.js <slug | feed-url> --undo
 *   node packages/db/src/corpus-opt-out.js --list
 *
 * The opposite ask from remove-feed.js, and the two get confused: this one
 * leaves the feed page, its post links and its RSS exactly as they are. What
 * it changes is everything that hands the publisher's writing on — the four
 * /api/dataset streams skip the feed, and the reader and the MCP read_post
 * tool stop serving text extracted from their pages (they frame the
 * publisher's own page or link out instead).
 *
 * Runs against DATABASE_URL like remove-feed.js does.
 */

import { connect } from './client.js';
import { listOptedOut, setDatasetOptOut } from './dataset.js';
import { feedBySlug, feedByUrl } from './queries.js';

function parse(argv) {
  const out = { target: null, undo: false, list: false };
  for (const arg of argv) {
    if (arg === '--list') out.list = true;
    else if (arg === '--undo') out.undo = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else out.target = arg;
  }
  return out;
}

async function main() {
  const opts = parse(process.argv.slice(2));
  const db = connect();

  if (opts.list) {
    const feeds = await listOptedOut(db);
    if (feeds.length === 0) console.log('no feed is opted out');
    for (const f of feeds) console.log(`/${f.slug}  ${f.feed_url}${f.title ? `  (${f.title})` : ''}`);
    return;
  }

  if (!opts.target) {
    console.error('usage: corpus-opt-out.js <slug|feed-url> [--undo] | --list');
    process.exit(2);
  }

  const feed = opts.target.includes('://')
    ? await feedByUrl(db, opts.target)
    : await feedBySlug(db, opts.target.replace(/^\//, ''));
  if (!feed) {
    console.error(`no feed matches ${opts.target}`);
    process.exit(1);
  }

  const slug = String(feed.slug);
  const changed = await setDatasetOptOut(db, slug, !opts.undo);
  const state = opts.undo ? 'back in the corpus' : 'out of the corpus, still in the directory';
  console.log(`/${slug} (${feed.feed_url}) is ${state}${changed ? '' : ' (already was)'}`);
}

// connect() may open a Redis-backed write queue that holds the event loop, so
// the script says when it is done rather than waiting for something to close.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
