import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

/**
 * The niche picker hides ISO 639-1 codes, because feeds tag themselves with
 * their language and those outrank real subjects. The list was hand-written
 * and shipped one short: Latin reached the live sign-up form as a checkbox
 * reading "la". A hand-kept list drifts, so this holds it to the standard.
 */
const CANONICAL = `aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de
dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is
it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na
nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr
ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu`
  .split(/\s+/)
  .filter(Boolean);

test('every ISO 639-1 code is excluded from the niche picker', async () => {
  const src = await readFile(new URL('../src/lib/partners.js', import.meta.url), 'utf8');
  const block = src.match(/const LANGUAGE_CODES = new Set\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(block, 'the LANGUAGE_CODES set should be findable');
  const listed = new Set([...block.matchAll(/'([a-z]{2})'/g)].map((m) => m[1]));

  const missing = CANONICAL.filter((code) => !listed.has(code));
  assert.deepEqual(missing, [], `these languages would be offered as niches: ${missing.join(', ')}`);
});

test('real two-letter subjects are still offered', async () => {
  const src = await readFile(new URL('../src/lib/partners.js', import.meta.url), 'utf8');
  const block = src.match(/const LANGUAGE_CODES = new Set\(\[([\s\S]*?)\]\);/)?.[1];
  const listed = new Set([...block.matchAll(/'([a-z]{2})'/g)].map((m) => m[1]));
  // The whole reason the codes are excluded by name rather than by length.
  assert.equal(listed.has('ai'), false, 'ai is a subject, not a language');
  assert.equal(listed.has('go'), false, 'go is a subject, not a language');
});
