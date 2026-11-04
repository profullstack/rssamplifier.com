import assert from 'node:assert/strict';
import { test } from 'node:test';

import { removedPublisherResponse } from '../src/lib/frameRemoval.js';

test('a removed publisher gets a no-store 410 response before it can be framed', async () => {
  let checkedUrl = null;
  const response = await removedPublisherResponse(
    'https://blog.marcolancini.it/posts/one',
    async (url) => {
      checkedUrl = url;
      return true;
    },
  );

  assert.equal(checkedUrl, 'https://blog.marcolancini.it/posts/one');
  assert.equal(response.status, 410);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  assert.match(await response.text(), /removed from RSSAmp/);
});

test('a publisher without a removal record continues through the normal frame path', async () => {
  const response = await removedPublisherResponse('https://example.com/post', async () => false);
  assert.equal(response, null);
});
