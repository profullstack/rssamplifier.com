import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHUNK_SIZE, chunkFilename, parseChunkFilename, esc } from '../src/lib/sitemap.js';

test('a chunk name round-trips between the index and the chunk route', () => {
  for (const chunk of [
    { month: '2026-08', part: 1 },
    { month: '2026-08', part: 2 },
    { month: '2026-12', part: 17 },
  ]) {
    assert.deepEqual(parseChunkFilename(chunkFilename(chunk)), chunk, chunkFilename(chunk));
  }

  // Part 1 is the bare name, so a month that fits reads like the single-file case.
  assert.equal(chunkFilename({ month: '2026-08' }), 'blogs-2026-08.xml');
  assert.equal(chunkFilename({ month: '2026-08', part: 3 }), 'blogs-2026-08-3.xml');
});

test('anything that is not a chunk name is rejected rather than queried', () => {
  for (const bad of [
    'static.xml',
    'blogs.xml',
    'blogs-2026-08',
    'blogs-2026-08.XML',
    'blogs-26-08.xml',
    'blogs-2026-8.xml',
    'blogs-2026-08-0.xml',
    'blogs-2026-08-x.xml',
    '../../etc/passwd',
    "blogs-2026-08'; drop table feeds; --.xml",
    '',
  ]) {
    assert.equal(parseChunkFilename(bad), null, `should reject ${JSON.stringify(bad)}`);
  }

  // `-1` is rejected on purpose: part 1 already has a name, and honouring both
  // would serve one file at two URLs.
  assert.equal(parseChunkFilename('blogs-2026-08-1.xml'), null);
});

test('the chunk size stays inside the sitemap spec ceiling', () => {
  assert.ok(CHUNK_SIZE > 0 && CHUNK_SIZE <= 50_000, `${CHUNK_SIZE} must fit in one sitemap`);
});

test('esc neutralises XML metacharacters', () => {
  assert.equal(esc('a & b <c>'), 'a &amp; b &lt;c&gt;');
  assert.equal(esc(null), '');
});
