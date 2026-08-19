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

test('the catch-up early return still exists to be checked against', () => {
  // If this ever goes away the rest of the file is asserting nothing, and a
  // silently vacuous test is worse than no test.
  positionOf('if (catchupOnly) return;');
});

test('an upload is drained even while the crawler is catching up', () => {
  assert.ok(
    positionOf('await drainImport(db)') < positionOf('if (catchupOnly) return;'),
    'drainImport must run before the catch-up return, or a submission sits at 0% for ever',
  );
});

test('and the submitter is told, since draining without telling is stranger still', () => {
  assert.ok(
    positionOf('await notifyFinishedSubmissions(db)') < positionOf('if (catchupOnly) return;'),
    'notifyFinishedSubmissions must run before the catch-up return: the daemon that drains ' +
      'the queue is the one that says it drained',
  );
});

test('discovery stays below the return, because nobody is waiting on it', () => {
  // The other half of the rule. Everything catch-up mode skips is work the
  // crawler gave itself; an import is work a person handed over and was given a
  // URL to watch. If this ever moves up, the mode has stopped meaning anything.
  assert.ok(
    positionOf('await notifyFinishedDiscoveries(db)') > positionOf('if (catchupOnly) return;'),
    'discovery notifications are housekeeping and belong after the catch-up return',
  );
});
