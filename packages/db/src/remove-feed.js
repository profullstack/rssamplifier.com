#!/usr/bin/env node
/**
 * Take a publisher out of the directory at their request, for good.
 *
 *   node packages/db/src/remove-feed.js https://someone.substack.com/feed \
 *     --reason "removal request by email 2026-08-23" --by someone@example.com
 *
 *   node packages/db/src/remove-feed.js --list
 *
 * Runs against TURSO_DATABASE_URL like migrate.js does. Deletes every feed on
 * the URL's host with its items, extracts and orphaned author, and records the
 * host in feed_removals so discovery and resubmission cannot bring it back.
 */

import { connect } from './client.js';
import { listRemovals, removeFeed } from './removals.js';

function parse(argv) {
  const out = { url: null, reason: null, by: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') out.list = true;
    else if (arg === '--reason') out.reason = argv[++i] ?? null;
    else if (arg === '--by') out.by = argv[++i] ?? null;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else out.url = arg;
  }
  return out;
}

async function main() {
  const opts = parse(process.argv.slice(2));
  const db = connect();

  if (opts.list) {
    const removals = await listRemovals(db);
    if (removals.length === 0) console.log('no removals on record');
    for (const r of removals) {
      console.log(
        `${r.created_at}  ${r.host}  ${r.items_removed} items` +
          `${r.requested_by ? `  by ${r.requested_by}` : ''}${r.reason ? `  (${r.reason})` : ''}`
      );
    }
    return;
  }

  if (!opts.url) {
    console.error('usage: remove-feed.js <feed-url> [--reason TEXT] [--by WHO] | --list');
    process.exit(2);
  }

  const result = await removeFeed(db, {
    feed_url: opts.url,
    reason: opts.reason,
    requested_by: opts.by,
  });
  if (result.feeds.length === 0) {
    console.log(`nothing listed on ${result.host}${result.already_recorded ? '; already on record' : ''}`);
  }
  for (const feed of result.feeds) {
    console.log(`removed /${feed.slug} (${feed.feed_url}): ${feed.items} items`);
  }
  if (result.authors_removed > 0) console.log(`removed ${result.authors_removed} orphaned author record(s)`);
  console.log(`${result.host} is now refused by every insert path`);
}

// connect() may open a Redis-backed write queue that holds the event loop, so
// the script says when it is done rather than waiting for something to close.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
