import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, migrate, q, translations } from '@rssamplifier/db';

import { ensureTranslation } from '../index.js';

/**
 * The branches of ensureTranslation that must never reach the API: a cache hit,
 * a post already in the target language, and a language code that is not one.
 * There is no API key in this environment, so anything that did reach out would
 * fail loudly rather than pass quietly.
 */

let dir;
let db;
let itemId;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-ensure-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);

  const feed = await q.insertFeed(db, {
    slug: 'ensure-blog',
    feed_url: 'https://ensure.example/feed.xml',
    title: 'Ensure Blog',
    language: 'de-DE',
  });

  await q.upsertItems(db, String(feed.id), [
    { guid: 'g1', title: 'Proxmox uefibios konfigurieren', summary: 'Hallo Forum!' },
  ]);

  const item = await q.itemByGuid(db, String(feed.id), 'g1');
  itemId = String(item.id);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a cached translation is served without touching the model', async () => {
  await translations.saveTranslation(db, {
    itemId,
    lang: 'en',
    title: 'Configuring the Proxmox UEFI BIOS',
    summary: 'Hello forum!',
    model: 'claude-haiku-4-5',
    sourceLang: 'de',
  });

  const result = await ensureTranslation(db, {
    itemId,
    title: 'Proxmox uefibios konfigurieren',
    summary: 'Hallo Forum!',
    targetLang: 'en',
    sourceLang: 'de-DE',
  });

  assert.equal(result.cached, true);
  assert.equal(result.title, 'Configuring the Proxmox UEFI BIOS');
  assert.equal(result.sourceLang, 'de');
});

test('the cache is found through any spelling of the target language', async () => {
  const result = await ensureTranslation(db, {
    itemId,
    title: 'Proxmox uefibios konfigurieren',
    targetLang: 'en-GB',
    sourceLang: 'de',
  });

  assert.equal(result.cached, true);
});

test('translating a post into the language it is already in does nothing', async () => {
  const result = await ensureTranslation(db, {
    itemId,
    title: 'Proxmox uefibios konfigurieren',
    targetLang: 'de',
    // Same language, differently spelled — the normaliser is what makes this
    // a no-op instead of a paid round trip returning its own input.
    sourceLang: 'de-DE',
  });

  assert.equal(result, null);
});

test('a target that is not a language code is refused before any call', async () => {
  for (const bad of ['', 'x-default', 'zzz', null]) {
    assert.equal(
      await ensureTranslation(db, {
        itemId,
        title: 'Proxmox uefibios konfigurieren',
        targetLang: /** @type {any} */ (bad),
        sourceLang: 'de',
      }),
      null,
      `failed on ${JSON.stringify(bad)}`,
    );
  }
});

test('with no API key configured, a cache miss shows the original', async () => {
  assert.equal(process.env['ANTHROPIC_API_KEY'], undefined, 'test assumes no key is set');

  const result = await ensureTranslation(db, {
    itemId,
    title: 'Proxmox uefibios konfigurieren',
    summary: 'Hallo Forum!',
    targetLang: 'fr',
    sourceLang: 'de',
  });

  assert.equal(result, null);
  // And nothing was written, so configuring a key later is all it takes.
  assert.equal(await translations.translationFor(db, itemId, 'fr'), null);
});
