import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import * as a from '../src/accounts.js';
import * as q from '../src/queries.js';
import * as t from '../src/translations.js';

let dir;
let db;
let itemId;
let userId;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rssamp-translations-'));
  db = connect({ url: `file:${join(dir, 'test.db')}` });
  await migrate(db);

  const feed = await q.insertFeed(db, {
    slug: 'proxmox-forum',
    feed_url: 'https://forum.example/feed.xml',
    site_url: 'https://forum.example/',
    title: 'Proxmox Forum',
    language: 'de-DE',
  });

  await q.upsertItems(db, String(feed.id), [
    {
      guid: 'urn:example:thread:1',
      url: 'https://forum.example/t/1',
      title: 'Proxmox uefibios konfigurieren',
      summary: 'Hallo Forum! Ich verzweifele dabei…',
    },
  ]);

  const item = await q.itemByGuid(db, String(feed.id), 'urn:example:thread:1');
  itemId = String(item.id);

  const user = await a.findOrCreateUser(db, 'reader@example.com');
  userId = String(user.id);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a post with no translation reads back as null', async () => {
  assert.equal(await t.translationFor(db, itemId, 'en'), null);
});

test('a saved translation reads back, keyed by language', async () => {
  await t.saveTranslation(db, {
    itemId,
    lang: 'en',
    title: 'Configuring the Proxmox UEFI BIOS',
    summary: 'Hello forum! I am despairing…',
    model: 'claude-haiku-4-5',
    sourceLang: 'de',
  });

  const row = await t.translationFor(db, itemId, 'en');
  assert.equal(row.title, 'Configuring the Proxmox UEFI BIOS');
  assert.equal(row.source_lang, 'de');

  // A different language is a different row, not an overwrite.
  assert.equal(await t.translationFor(db, itemId, 'fr'), null);
});

test('re-translating replaces the row rather than failing on the key', async () => {
  await t.saveTranslation(db, {
    itemId,
    lang: 'en',
    title: 'Configuring the UEFI BIOS in Proxmox',
    summary: null,
    model: 'claude-haiku-5',
  });

  const row = await t.translationFor(db, itemId, 'en');
  assert.equal(row.title, 'Configuring the UEFI BIOS in Proxmox');
  assert.equal(row.summary, null);
  assert.equal(row.model, 'claude-haiku-5');
});

test('itemText fetches the source a translator works from', async () => {
  const item = await t.itemText(db, itemId);
  assert.equal(item.title, 'Proxmox uefibios konfigurieren');
  assert.match(String(item.summary), /^Hallo Forum!/);

  assert.equal(await t.itemText(db, 'nope'), null);
});

test('languageCounts reports the raw tags, commonest first', async () => {
  const counts = await t.languageCounts(db);
  assert.deepEqual(counts, [{ language: 'de-DE', feeds: 1 }]);
});

test('a reader has no reading language until they pick one', async () => {
  assert.equal(await t.readingLanguage(db, userId), null);

  await t.setReadingLanguage(db, userId, 'en');
  assert.equal(await t.readingLanguage(db, userId), 'en');

  // Clearing is a real choice — it is how a reader gets back to the original.
  await t.setReadingLanguage(db, userId, null);
  assert.equal(await t.readingLanguage(db, userId), null);
});

test('usage counts up per reader per day, and sums across readers', async () => {
  const day = t.usageDay();
  const other = String((await a.findOrCreateUser(db, 'other@example.com')).id);

  assert.equal(await t.usageForUser(db, userId, day), 0);
  assert.equal(await t.usageForDay(db, day), 0);

  assert.equal(await t.recordUsage(db, userId, day), 1);
  assert.equal(await t.recordUsage(db, userId, day), 2);
  await t.recordUsage(db, other, day);

  assert.equal(await t.usageForUser(db, userId, day), 2);
  assert.equal(await t.usageForUser(db, other, day), 1);
  assert.equal(await t.usageForDay(db, day), 3);
});

test('usage is scoped to its own day', async () => {
  // Fixed dates well away from the real one: the ledger is shared across this
  // file, so borrowing today's date would count the rows an earlier test wrote.
  const before = t.usageDay(new Date('2020-01-01T23:59:59Z'));
  const after = t.usageDay(new Date('2020-01-02T00:00:01Z'));
  assert.notEqual(before, after);

  await t.recordUsage(db, userId, before);
  assert.equal(await t.usageForUser(db, userId, before), 1);
  assert.equal(await t.usageForUser(db, userId, after), 0);
});

test('usageDay is a UTC calendar day, so the global cap is one window', () => {
  assert.equal(t.usageDay(new Date('2026-08-16T00:00:00Z')), '2026-08-16');
  assert.equal(t.usageDay(new Date('2026-08-16T23:59:59Z')), '2026-08-16');
});

test('deleting a post takes its translations with it', async () => {
  await t.saveTranslation(db, {
    itemId,
    lang: 'fr',
    title: 'Configurer le BIOS UEFI de Proxmox',
    model: 'claude-haiku-4-5',
  });

  await db.execute({ sql: 'delete from feed_items where id = ?', args: [itemId] });
  assert.equal(await t.translationFor(db, itemId, 'fr'), null);
});
