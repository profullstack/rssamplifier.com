import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE_LANGUAGE, languageName, normalizeLang, offeredLanguages } from '../index.js';

test('normalizeLang folds every spelling of a tag onto one code', () => {
  for (const raw of ['de', 'DE', 'de-DE', 'de_DE', ' de-de ', 'De-Latn-DE']) {
    assert.equal(normalizeLang(raw), 'de', `failed on ${JSON.stringify(raw)}`);
  }
});

test('normalizeLang refuses what it cannot fold, rather than guessing', () => {
  for (const raw of ['', '   ', 'x-default', 'eng', 'e', '123', null, undefined]) {
    assert.equal(normalizeLang(raw), null, `failed on ${JSON.stringify(raw)}`);
  }
});

test('offeredLanguages ranks by how much of the directory is in each', () => {
  const offered = offeredLanguages([
    { language: 'de', feeds: 400 },
    { language: 'es', feeds: 900 },
    { language: 'fr', feeds: 50 },
  ]);

  assert.deepEqual(offered, ['en', 'es', 'de', 'fr']);
});

test('offeredLanguages sums the variants of one language before ranking', () => {
  // 'de' would lose to 'fr' on any single row and wins once they are folded —
  // this is the whole reason normalisation happens before counting.
  const offered = offeredLanguages([
    { language: 'fr', feeds: 300 },
    { language: 'de-DE', feeds: 200 },
    { language: 'de-AT', feeds: 150 },
  ]);

  assert.deepEqual(offered, ['en', 'de', 'fr']);
});

test('offeredLanguages always leads with English, even absent from the counts', () => {
  const offered = offeredLanguages([{ language: 'ja', feeds: 10 }]);
  assert.equal(offered[0], BASE_LANGUAGE);
});

test('offeredLanguages does not list English twice when the counts hold it', () => {
  const offered = offeredLanguages([
    { language: 'en-GB', feeds: 5000 },
    { language: 'en-US', feeds: 4000 },
    { language: 'de', feeds: 10 },
  ]);

  assert.deepEqual(offered, ['en', 'de']);
});

test('offeredLanguages caps the bar, but never below the pinned languages', () => {
  const counts = ['de', 'es', 'fr', 'ja', 'nl', 'pt', 'ru', 'sv'].map((language, i) => ({
    language,
    feeds: 100 - i,
  }));

  assert.deepEqual(offeredLanguages(counts, { max: 3 }), ['en', 'de', 'es']);
  // The cap never truncates a pinned language off the end: a bar without the
  // language the reader is already in is not a bar they can get back from.
  assert.deepEqual(offeredLanguages(counts, { max: 1, always: ['en', 'de'] }), ['en', 'de']);
});

test('offeredLanguages drops rows it cannot normalise', () => {
  const offered = offeredLanguages([
    { language: 'x-default', feeds: 9999 },
    { language: 'de', feeds: 1 },
  ]);

  assert.deepEqual(offered, ['en', 'de']);
});

test('languageName names a language in its own words', () => {
  assert.equal(languageName('de'), 'Deutsch');
  assert.equal(languageName('es'), 'español');
});

test('languageName can name a language in a given locale instead', () => {
  // For prose: "Translated from German" reads; "Translated from Deutsch" does not.
  assert.equal(languageName('de', 'en'), 'German');
  assert.equal(languageName('en', 'de'), 'Englisch');
});

test('languageName falls back to the code rather than throwing', () => {
  assert.equal(languageName('zz'), 'ZZ');
});
