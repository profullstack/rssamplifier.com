import test from 'node:test';
import assert from 'node:assert/strict';

import { opmlStream } from '../src/app/opml/route.js';

/**
 * The OPML export advances at the reader's pace.
 *
 * The bug this guards against was invisible in the output: the document was
 * correct, complete and streamed, and every byte of it sat in memory at once
 * because the stream was filled from `start()` faster than anyone read it.
 * So these tests do not look at the document much. They look at the cursor,
 * and ask how far it was pulled while the consumer was not reading.
 */

/**
 * A cursor over `total` rows that remembers how far it was asked to go.
 *
 * @param {number} total
 */
function cursor(total) {
  let asked = 0;
  let returned = false;
  const rows = {
    asked: () => asked,
    returned: () => returned,
    async next() {
      if (asked >= total) return { value: undefined, done: true };
      asked += 1;
      return {
        value: { title: `Feed ${asked}`, feed_url: `https://example.com/${asked}.xml`, site_url: null },
        done: false,
      };
    },
    async return() {
      returned = true;
      return { value: undefined, done: true };
    },
  };
  return rows;
}

/** @param {Uint8Array[]} chunks */
const text = (chunks) => new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));

test('the cursor is not pulled past what the consumer has taken', async () => {
  const rows = cursor(100_000);
  const reader = opmlStream(rows, { title: 'test', limit: null }).getReader();

  // Take the head and one chunk of outlines, then stop reading.
  await reader.read();
  await reader.read();

  // Give a runaway producer every chance to run away.
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(
    rows.asked() <= 1_500,
    `cursor was pulled ${rows.asked()} rows for a consumer that took one chunk`,
  );
});

test('a consumer that goes away closes the cursor', async () => {
  const rows = cursor(100_000);
  const reader = opmlStream(rows, { title: 'test', limit: null }).getReader();

  await reader.read();
  await reader.cancel();

  assert.equal(rows.returned(), true, 'the database is not asked for the rest');
});

test('a full read is a complete, well-formed document', async () => {
  const rows = cursor(1_234);
  const chunks = [];
  const reader = opmlStream(rows, { title: 'Everything', limit: null }).getReader();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const doc = text(chunks);
  assert.match(doc, /^<\?xml/, 'starts with the head');
  assert.match(doc, /<\/opml>\s*$/, 'ends with the foot');
  assert.equal((doc.match(/<outline /g) ?? []).length, 1_234, 'every row, once');
  assert.equal(rows.asked(), 1_234);
});

test('?limit= stops the cursor as well as the document', async () => {
  const rows = cursor(100_000);
  const chunks = [];
  const reader = opmlStream(rows, { title: 'Sample', limit: 750 }).getReader();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const doc = text(chunks);
  assert.equal((doc.match(/<outline /g) ?? []).length, 750);
  assert.match(doc, /<\/opml>\s*$/);
  assert.ok(rows.asked() <= 751, `cursor was pulled ${rows.asked()} rows for a limit of 750`);
});
