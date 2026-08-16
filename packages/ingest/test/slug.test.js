import assert from 'node:assert/strict';
import { test } from 'node:test';

import { uniqueSlug } from '@rssamplifier/feed';

/**
 * Mirrors the placeholder handling in submit.js claimSlug().
 *
 * @param {string} title
 * @param {string} feedUrl
 * @param {(s: string) => boolean} [taken]
 * @returns {string}
 */
function claim(title, feedUrl, taken = () => false) {
  const usable = title === '(untitled)' ? '' : title;
  return uniqueSlug(usable, feedUrl, taken);
}

test('a feed with no title is slugged from its hostname, not "untitled"', () => {
  // parseFeed substitutes '(untitled)' when a feed omits <title>. Slugifying
  // that literal gives a valid "untitled", which silently defeats the hostname
  // fallback — danluu.com landed on /untitled in production because of it.
  assert.equal(claim('(untitled)', 'https://danluu.com/atom.xml'), 'danluu-com');
  assert.equal(claim('(untitled)', 'https://www.example.org/feed'), 'example-org');
});

test('two different untitled feeds do not collide on one slug', () => {
  const taken = new Set();

  const first = claim('(untitled)', 'https://danluu.com/atom.xml', (s) => taken.has(s));
  taken.add(first);
  const second = claim('(untitled)', 'https://example.org/feed', (s) => taken.has(s));

  assert.notEqual(first, second);
  assert.equal(first, 'danluu-com');
  assert.equal(second, 'example-org');
});

test('a real title is still preferred over the hostname', () => {
  assert.equal(claim('Simon Willison’s Weblog', 'https://simonwillison.net/atom/everything/'),
    'simon-willisons-weblog');
});
