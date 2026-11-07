import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { q, translations, accounts } from '@rssamplifier/db';
import { connectTest } from '@rssamplifier/db/src/testdb.js';

import { AiRouter } from '@profullstack/ai-providers';

import {
  DEFAULT_DAILY_PER_USER,
  DEFAULT_DAILY_TOTAL,
  DEFAULT_WAIT_MS,
  ensureTranslation,
  limits,
  pendingTranslations,
} from '../index.js';

// No provider at all unless a test hands one in: c0mpute off, no paid keys.
process.env['C0MPUTE_DISABLED'] = '1';

/**
 * The branches of ensureTranslation that must never reach the API: a cache hit,
 * a post already in the target language, a language code that is not one, and —
 * the point of the spend ceiling — a reader who has had their share for today.
 *
 * There is no API key in this environment, so anything that did reach out would
 * fail rather than pass quietly.
 */

let db;
let itemId;
let userId;
let otherId;

before(async () => {
  db = await connectTest();

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

  userId = String((await accounts.findOrCreateUser(db, 'reader@example.com')).id);
  otherId = String((await accounts.findOrCreateUser(db, 'other@example.com')).id);
});

beforeEach(async () => {
  await db.execute('delete from translation_usage');
  delete process.env['TRANSLATE_DAILY_PER_USER'];
  delete process.env['TRANSLATE_DAILY_TOTAL'];
  delete process.env['TRANSLATE_WAIT_MS'];
});

after(async () => {
  db.close();
});

/**
 * @param {object} [over]
 */
function ask(over = {}) {
  return ensureTranslation(db, {
    itemId,
    title: 'Proxmox uefibios konfigurieren',
    summary: 'Hallo Forum!',
    targetLang: 'fr',
    sourceLang: 'de',
    userId,
    ...over,
  });
}

test('a cached translation is served without touching the model', async () => {
  await translations.saveTranslation(db, {
    itemId,
    lang: 'en',
    title: 'Configuring the Proxmox UEFI BIOS',
    summary: 'Hello forum!',
    model: 'claude-haiku-4-5',
    sourceLang: 'de',
  });

  const { translation, limited } = await ask({ targetLang: 'en' });

  assert.equal(limited, false);
  assert.equal(translation.cached, true);
  assert.equal(translation.title, 'Configuring the Proxmox UEFI BIOS');
  assert.equal(translation.sourceLang, 'de');
});

test('the cache is found through any spelling of the target language', async () => {
  const { translation } = await ask({ targetLang: 'en-GB' });
  assert.equal(translation.cached, true);
});

test('a cache hit costs nothing, however many times it is read', async () => {
  for (let i = 0; i < 25; i += 1) await ask({ targetLang: 'en' });

  const day = translations.usageDay();
  assert.equal(await translations.usageForUser(db, userId, day), 0);
});

test('a cache hit is served even after the reader is out of translations', async () => {
  process.env['TRANSLATE_DAILY_PER_USER'] = '1';
  const day = translations.usageDay();
  await translations.recordUsage(db, userId, day);

  // Already paid for by somebody, so the ceiling has nothing to say about it.
  const { translation, limited } = await ask({ targetLang: 'en' });
  assert.equal(limited, false);
  assert.equal(translation.cached, true);
});

test('translating a post into the language it is already in does nothing', async () => {
  const { translation } = await ask({ targetLang: 'de', sourceLang: 'de-DE' });
  assert.equal(translation, null);

  // And it is not metered, because it never reaches the API.
  assert.equal(await translations.usageForUser(db, userId, translations.usageDay()), 0);
});

test('a target that is not a language code is refused before any call', async () => {
  for (const bad of ['', 'x-default', 'zzz', null]) {
    const { translation } = await ask({ targetLang: bad });
    assert.equal(translation, null, `failed on ${JSON.stringify(bad)}`);
  }
});

test('an anonymous caller never reaches the paid path', async () => {
  // Defence in depth: the route and the page both gate on a session already.
  // If either ever stops, there is still nobody to meter here, so nothing is
  // spent rather than something being spent untracked.
  const { translation, limited } = await ask({ userId: null });
  assert.equal(translation, null);
  assert.equal(limited, false);
});

test('with no API key configured, a cache miss shows the original', async () => {
  assert.equal(process.env['ANTHROPIC_API_KEY'], undefined, 'test assumes no key is set');

  const { translation } = await ask();
  assert.equal(translation, null);
  // And nothing was written, so configuring a key later is all it takes.
  assert.equal(await translations.translationFor(db, itemId, 'fr'), null);
});

test('a failed call is still charged, so failures are not a free retry loop', async () => {
  // No API key here means translatePost returns null — the same shape as a
  // refusal or a timeout. The attempt must still count, or anyone who can make
  // the model fail can spend without limit.
  await ask();
  assert.equal(await translations.usageForUser(db, userId, translations.usageDay()), 1);
});

test('a reader is cut off at their daily limit', async () => {
  process.env['TRANSLATE_DAILY_PER_USER'] = '3';

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await ask()).limited, false, `attempt ${i} should be allowed`);
  }

  const { translation, limited } = await ask();
  assert.equal(limited, true);
  assert.equal(translation, null);

  // Cut off means cut off: the fourth attempt was not quietly charged.
  assert.equal(await translations.usageForUser(db, userId, translations.usageDay()), 3);
});

test('one reader hitting their limit does not cut off another', async () => {
  process.env['TRANSLATE_DAILY_PER_USER'] = '1';
  process.env['TRANSLATE_DAILY_TOTAL'] = '100';

  await ask();
  assert.equal((await ask()).limited, true);
  assert.equal((await ask({ userId: otherId })).limited, false);
});

test('the global ceiling stops an attacker minting fresh accounts', async () => {
  // Sign-up is a magic link to any address, so the per-user limit alone only
  // decides how many accounts an attacker needs. This is the one that bounds
  // the bill.
  process.env['TRANSLATE_DAILY_PER_USER'] = '100';
  process.env['TRANSLATE_DAILY_TOTAL'] = '2';

  await ask();
  await ask({ userId: otherId });

  const day = translations.usageDay();
  assert.equal(await translations.usageForDay(db, day), 2);

  // A brand-new account is over the line before its first request.
  const fresh = String((await accounts.findOrCreateUser(db, 'burner@example.com')).id);
  assert.equal((await ask({ userId: fresh })).limited, true);
});

test("yesterday's spending does not count against today", async () => {
  process.env['TRANSLATE_DAILY_PER_USER'] = '1';

  const yesterday = translations.usageDay(new Date(Date.now() - 24 * 60 * 60 * 1000));
  await translations.recordUsage(db, userId, yesterday);

  assert.equal((await ask()).limited, false);
});

test('limits fall back to the defaults rather than to no limit', async () => {
  assert.deepEqual(limits(), {
    perUser: DEFAULT_DAILY_PER_USER,
    total: DEFAULT_DAILY_TOTAL,
    waitMs: DEFAULT_WAIT_MS,
  });

  // A typo in a Railway variable must not uncap spending.
  for (const bad of ['', 'lots', '0', '-5', 'NaN']) {
    process.env['TRANSLATE_DAILY_TOTAL'] = bad;
    assert.equal(limits().total, DEFAULT_DAILY_TOTAL, `failed on ${JSON.stringify(bad)}`);
  }

  process.env['TRANSLATE_DAILY_TOTAL'] = '250';
  assert.equal(limits().total, 250);
});

/**
 * A c0mpute stand-in that answers in the tagged format after `ms`.
 *
 * @param {number} ms
 */
function peer(ms) {
  const provider = {
    name: 'c0mpute',
    calls: 0,
    /** @param {any} req */
    async generate(req) {
      provider.calls += 1;
      provider.last = req;
      await new Promise((r) => setTimeout(r, ms));
      return {
        text: '<title>Configurer le BIOS UEFI de Proxmox</title>\n<summary>Bonjour le forum !</summary>\n<source_language>de</source_language>',
        model: 'qwen-9b',
        usage: { inputTokens: 1, outputTokens: 1, estimated: true },
      };
    },
    last: /** @type {any} */ (null),
  };
  return provider;
}

test('c0mpute answers first, and a quick answer is shown and cached on the first click', async () => {
  await db.execute('delete from item_translations');
  const provider = peer(5);
  const { translation, limited } = await ask({ ai: new AiRouter({ primary: [provider] }) });

  assert.equal(limited, false);
  assert.equal(translation.title, 'Configurer le BIOS UEFI de Proxmox');
  assert.equal(translation.summary, 'Bonjour le forum !');
  assert.match(provider.last.system, /<source_language>/);

  const row = await translations.translationFor(db, itemId, 'fr');
  assert.equal(row.model, 'c0mpute:qwen-9b');
});

test('a slow translation runs in the background: pending now, a cache hit later, charged once', async () => {
  await db.execute('delete from item_translations');
  process.env['TRANSLATE_WAIT_MS'] = '10';
  const provider = peer(150);
  const ai = new AiRouter({ primary: [provider] });

  const first = await ask({ ai });
  assert.equal(first.translation, null);
  assert.equal(first.pending, true);

  // Asking again while it runs is not a second call and not a second charge.
  const second = await ask({ ai });
  assert.equal(second.pending, true);
  assert.equal(provider.calls, 1);
  assert.equal(await translations.usageForUser(db, userId, translations.usageDay()), 1);

  await Promise.all(pendingTranslations());
  const third = await ask({ ai });
  assert.equal(third.translation.cached, true);
  assert.equal(third.translation.title, 'Configurer le BIOS UEFI de Proxmox');
});

test('an answer that is not in the tagged format shows the original', async () => {
  await db.execute('delete from item_translations');
  const junk = {
    name: 'c0mpute',
    async generate() {
      return { text: 'Sure! Here is your translation: ...', model: 'm', usage: { inputTokens: 0, outputTokens: 0, estimated: true } };
    },
  };
  const { translation, pending } = await ask({ ai: new AiRouter({ primary: [junk] }) });
  assert.equal(translation, null);
  assert.equal(pending, undefined);
  assert.equal(await translations.translationFor(db, itemId, 'fr'), null);
});
