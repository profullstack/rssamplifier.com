import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clamp, plainText, shareText } from '../src/lib/share.js';

const URL = 'https://rssamplifier.com/webfive/read?p=3504d80b-b4bf-4196-923b-7ed8b60caec9';

test('a summary made of markup is copied as words', () => {
  assert.equal(
    plainText('<p>First para.</p><p>Second <em>para</em>.</p>'),
    'First para. Second para.',
  );
  // Without a space in place of the block, "para.Second" is what gets pasted.
  assert.ok(!plainText('<p>a</p><p>b</p>').includes('ab'));
  assert.equal(plainText('Tom &amp; Jerry &nbsp;&quot;hi&quot;'), 'Tom & Jerry "hi"');
  assert.equal(plainText(null), '');
});

test('clamping stops at a word, and says that it stopped', () => {
  assert.equal(clamp('short enough', 40), 'short enough');

  const long = clamp('the quick brown fox jumps over the lazy dog', 20);
  assert.ok(long.endsWith('…'));
  assert.ok(long.length <= 21);
  // Cut at a space, so no word is left as a fragment.
  assert.ok(!/\w…$/.test(long) || long === 'the quick brown fox…');

  // One word longer than the limit has no boundary to fall back to.
  assert.equal(clamp('supercalifragilistic', 8), 'supercal…');
});

test('the blurb is the title, the gist and the link', () => {
  assert.equal(
    shareText({ title: 'Web Five', summary: '<p>A post about feeds.</p>', url: URL }),
    `Web Five\n\nA post about feeds.\n\n${URL}`,
  );
});

test('a feed that repeats its title in the summary does not paste it twice', () => {
  assert.equal(shareText({ title: 'New comic!', summary: 'New comic!', url: URL }), `New comic!\n\n${URL}`);
});

test('a post with no summary still shares', () => {
  assert.equal(shareText({ title: 'Untitled thought', summary: null, url: URL }), `Untitled thought\n\n${URL}`);
  assert.equal(shareText({ title: 'Untitled thought', url: URL }), `Untitled thought\n\n${URL}`);
});

test('a whole article is trimmed to something pasteable', () => {
  const body = `<p>${'word '.repeat(400)}</p>`;
  const text = shareText({ title: 'Long one', summary: body, url: URL });

  const [, gist] = text.split('\n\n');
  assert.ok(gist.length <= 281, `gist was ${gist.length} characters`);
  assert.ok(gist.endsWith('…'));
  // The link survives the trim — it is the part of the blurb that has to.
  assert.ok(text.endsWith(URL));
});
