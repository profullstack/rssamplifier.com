import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * That two people cannot silently claim the same migration slot.
 *
 * On 2026-08-19 two branches both took `0032` — `0032_feed_refetch_signals.sql`
 * (#127) and `0032_queue_hourly.sql` (#128). Git raised no conflict, because
 * they are different filenames; nothing failed and nothing warned. Both applied
 * cleanly, since `migrate()` keys `_migrations` on the filename rather than the
 * number, so this cost nothing that day — but it was luck, and the next pair
 * might not commute.
 *
 * A convention in a README does not stop this happening again. Whoever merges
 * second is never prompted to renumber, because the tool that would prompt them
 * sees two unrelated new files. This is the prompt.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * The last sequential number ever issued.
 *
 * Everything up to here is frozen history and keeps its name; see the README
 * for why an applied migration must never be renamed. Anything new must be a
 * timestamp, and this is what makes that a rule rather than a suggestion.
 */
const LAST_SEQUENTIAL = 32;

/**
 * The duplicates that already shipped, which cannot be renamed away.
 *
 * Writing this test surfaced that `0032` was not the first time — it was the
 * third, and `0018` was claimed by *three* separate files. None of it ever
 * failed and none of it was ever noticed, which is precisely the argument: a
 * silent fault that costs nothing for a year is still a fault, and it only has
 * to meet one pair of order-dependent migrations to stop being free.
 *
 * Recorded rather than tidied. Every one of these is applied in production and
 * keyed by filename, so renaming any of them would make the runner treat it as
 * new and run it a second time — survivable for a purely additive file, not for
 * the three that carry `insert` and `update` statements.
 */
const GRANDFATHERED = new Set([
  '0006_feed_items_created_idx.sql',
  '0006_feeds_sitemap_index.sql',
  '0018_crawl_log.sql',
  '0018_queue.sql',
  '0018_scraped_feeds.sql',
  '0032_feed_refetch_signals.sql',
  '0032_queue_hourly.sql',
]);

const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();

test('there are migrations to check', () => {
  assert.ok(files.length > 30, `only found ${files.length}`);
});

test('every migration is named for when it was written, or is frozen history', () => {
  for (const file of files) {
    const match = /^(\d{4}|\d{14})_[a-z0-9_]+\.sql$/.exec(file);
    assert.ok(match, `${file}: expected YYYYMMDDHHMMSS_lower_snake_case.sql`);

    const prefix = match[1];
    if (prefix.length === 14) continue;

    assert.ok(
      Number(prefix) <= LAST_SEQUENTIAL,
      `${file}: sequential numbering stopped at ${LAST_SEQUENTIAL}. Name a new migration ` +
        `for the moment it was written — \`date -u +%Y%m%d%H%M%S\` — because the next number ` +
        `is not knowable from a branch, and 0006, 0018 and 0032 were each claimed twice ` +
        `or more before anybody noticed.`,
    );
  }
});

test('no two migrations claim the same slot', () => {
  const seen = new Map();

  for (const file of files) {
    if (GRANDFATHERED.has(file)) continue;
    const prefix = file.slice(0, file.indexOf('_'));
    const first = seen.get(prefix);
    assert.equal(
      first,
      undefined,
      `${file} and ${first} share the prefix ${prefix}. Git will not have flagged this — ` +
        `they are different filenames — so rename the one that has NOT been applied to ` +
        `production yet. Never rename one that has.`,
    );
    seen.set(prefix, file);
  }
});

test('a timestamped migration names a real moment that has passed', () => {
  for (const file of files) {
    const prefix = file.slice(0, 14);
    if (!/^\d{14}$/.test(prefix)) continue;

    const [y, mo, d, h, mi, s] = [
      prefix.slice(0, 4),
      prefix.slice(4, 6),
      prefix.slice(6, 8),
      prefix.slice(8, 10),
      prefix.slice(10, 12),
      prefix.slice(12, 14),
    ].map(Number);

    const at = Date.UTC(y, mo - 1, d, h, mi, s);
    assert.ok(Number.isFinite(at), `${file}: unparseable timestamp`);
    assert.equal(mo >= 1 && mo <= 12, true, `${file}: month ${mo}`);
    assert.equal(d >= 1 && d <= 31, true, `${file}: day ${d}`);
    assert.equal(h <= 23 && mi <= 59 && s <= 59, true, `${file}: time ${h}:${mi}:${s}`);
    // A future timestamp sorts after everything and would jump the queue for
    // however long it stays in the future — usually a typo'd year or a machine
    // with a bad clock.
    assert.ok(at <= Date.now(), `${file}: dated in the future`);
  }
});

test('history still runs before anything new, whatever is added later', () => {
  // The reason the old files can simply be left alone: `migrate()` sorts
  // lexically and '0' precedes '2', so every 0001-0032 file sorts before every
  // 20xx timestamp. Asserted rather than assumed, because the whole no-rename
  // decision rests on it.
  const sequential = files.filter((f) => /^\d{4}_/.test(f));
  const timestamped = files.filter((f) => /^\d{14}_/.test(f));

  if (sequential.length === 0 || timestamped.length === 0) return;

  const lastOld = sequential[sequential.length - 1];
  const firstNew = timestamped[0];
  assert.ok(lastOld < firstNew, `${lastOld} must sort before ${firstNew}`);
  assert.equal(files.indexOf(lastOld) < files.indexOf(firstNew), true);
});
