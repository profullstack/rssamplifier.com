import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OPTED_OUT, readerView } from '../src/lib/reader.js';

/**
 * A publisher who opted out of the corpus stays readable on their own page and
 * nowhere else: no article is extracted, stored or served. The probe is stubbed
 * because the real one refuses private hosts, and the database is never set up
 * on purpose — the opt-out path must not touch the extract cache at all, so a
 * stray `db()` call fails this file rather than passing quietly.
 */

const ARTICLE = `<html><body><article><h1>Title</h1>${'<p>Their whole article, word for word.</p>'.repeat(40)}</article></body></html>`;

test('a refused frame ends in the link out, never in their article', async () => {
  const view = await readerView(
    { itemId: 'item-1', url: 'https://joho.example/post', optOut: true },
    {
      probe: async () => ({
        frameable: false,
        reason: 'x-frame-options:deny',
        html: ARTICLE,
        contentType: 'text/html',
      }),
    },
  );
  assert.equal(view.frameable, false);
  assert.equal(view.reason, OPTED_OUT);
  assert.equal(view.article, null);
});

test('their own page may still be framed: that is their server answering', async () => {
  const view = await readerView(
    { itemId: 'item-1', url: 'https://joho.example/post', optOut: true },
    { probe: async () => ({ frameable: true, reason: 'allowed', html: ARTICLE, contentType: 'text/html' }) },
  );
  assert.equal(view.frameable, true);
  assert.equal(view.article, null);
});

test('a probe that throws still ends in the link out', async () => {
  const view = await readerView(
    { itemId: 'item-1', url: 'https://joho.example/post', optOut: true },
    {
      probe: async () => {
        throw new Error('down');
      },
    },
  );
  assert.deepEqual(view, { frameable: false, reason: OPTED_OUT, article: null });
});
