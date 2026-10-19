import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * That catch-up mode cannot strand somebody's upload again.
 *
 * On 2026-08-19 a 109,474-entry list was submitted. Every entry staged in 55
 * seconds and then nothing happened at all: `queued_count` stayed 0, the
 * submitter's page said "working", and it would have said so for ever. The
 * cause was position — `drainImport` sat eleven lines *below*
 * `if (catchupOnly) return`, and `CRAWL_CATCHUP=1` is set on the poller.
 *
 * Nothing errored and nothing logged, because from the tick's point of view
 * nothing went wrong; it simply never reached the queue a person was waiting
 * on. The only way to find it was to read this file.
 *
 * This is a source-order assertion rather than a real test of `tick()`, and
 * that is a compromise worth naming: `apps/poller/src/index.js` connects to a
 * database and starts timers at import, so it cannot be loaded by a test
 * without a refactor far larger than the bug. Checking the order of three
 * lines in the source is crude, and it does hold the one invariant whose
 * violation is invisible from the outside.
 */

const POLLER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const source = await readFile(POLLER, 'utf8');

/**
 * Where a snippet appears, asserted to be present exactly once so a rename
 * fails loudly here rather than silently passing on the wrong line.
 *
 * @param {string} needle
 * @returns {number}
 */
function positionOf(needle) {
  const first = source.indexOf(needle);
  assert.notEqual(first, -1, `expected to find ${JSON.stringify(needle)} in the poller`);
  assert.equal(
    source.indexOf(needle, first + 1),
    -1,
    `${JSON.stringify(needle)} appears more than once; this check needs a better anchor`,
  );
  return first;
}

/**
 * The body of one top-level function in the poller, by its declaration.
 *
 * @param {string} name
 */
function bodyOf(name) {
  const start = positionOf(`async function ${name}(`);
  const next = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

// Since the move to @profullstack/scraper-daemon there is no early return to
// sit above or below: catch-up mode decides which *jobs* are registered (see
// src/daemon.js and test/daemon.test.js, which asserts that `import` survives
// catch-up mode and `discovery-*` does not). What is left to hold here is that
// each call lives in the job it belongs to.

test('an upload is drained by the import job, which catch-up mode keeps', () => {
  assert.match(bodyOf('importTick'), /await drainImport\(db\)/);
  assert.match(source, /import: importTick,/);
});

test('and the submitter is told by the same job, since draining without telling is stranger still', () => {
  assert.match(bodyOf('importTick'), /await notifyFinishedSubmissions\(db\)/);
});

test('discovery notifications are their own job, which catch-up mode drops', () => {
  // The other half of the rule. Everything catch-up mode skips is work the
  // crawler gave itself; an import is work a person handed over and was given a
  // URL to watch. If this ever moves into the import job, the mode has stopped
  // meaning anything.
  assert.match(bodyOf('discoveryNotifyTick'), /await notifyFinishedDiscoveries\(db\)/);
  assert.doesNotMatch(bodyOf('importTick'), /notifyFinishedDiscoveries/);
  assert.match(source, /discoveryNotify: discoveryNotifyTick,/);
});
