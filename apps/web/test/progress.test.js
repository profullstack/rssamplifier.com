import test from 'node:test';
import assert from 'node:assert/strict';

import { busyLine } from '../src/lib/progress.js';

test('names the keyword the inline pass is searching', () => {
  assert.equal(
    busyLine({ name: 'icelandic sheepdog', left: 1, running: true }),
    'searching “icelandic sheepdog”…',
  );
});

test('names the one in flight and counts the rest', () => {
  assert.equal(
    busyLine({ name: 'huskies', left: 3, running: true }),
    'searching “huskies” — 3 keywords left…',
  );
});

test('does not claim a search once the run belongs to the poller', () => {
  // The inline loop stops at its budget. Saying "searching" after that would be
  // the same false impression this line exists to remove, pointed the other way.
  assert.equal(
    busyLine({ name: 'finnish lapphund', left: 1, running: false }),
    '“finnish lapphund” is queued for the crawler…',
  );
  assert.equal(
    busyLine({ name: 'finnish lapphund', left: 3, running: false }),
    '“finnish lapphund” and 2 more are queued for the crawler…',
  );
});

test('falls back to the count when the name is missing', () => {
  assert.equal(busyLine({ name: null, left: 2, running: true }), 'searching — 2 keywords left…');
  assert.equal(
    busyLine({ name: null, left: 2, running: false }),
    '2 keywords queued for the crawler…',
  );
});

test('says nothing once there is a log to read', () => {
  // The caller passes null as soon as candidate sites exist: from there every
  // site checked writes its own line, and this would only be noise over it.
  assert.equal(busyLine(null), null);
  assert.equal(busyLine(undefined), null);
  assert.equal(busyLine({ name: 'x', left: 0, running: true }), null);
  assert.equal(busyLine({}), null);
});
