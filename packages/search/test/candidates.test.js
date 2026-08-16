import test from 'node:test';
import assert from 'node:assert/strict';

import { parseKeywords, candidateSites, isCandidateLink, apexOf } from '../index.js';

test('parseKeywords keeps a phrase together', () => {
  // The whole reason this is not the URL splitter: spaces are part of a keyword.
  assert.deepEqual(parseKeywords('siberian huskies'), ['siberian huskies']);
});

test('parseKeywords splits on newlines and commas only', () => {
  assert.deepEqual(parseKeywords('siberian huskies\nsourdough baking, retro computing'), [
    'siberian huskies',
    'sourdough baking',
    'retro computing',
  ]);
});

test('parseKeywords collapses whitespace, drops blanks and dedupes case-insensitively', () => {
  assert.deepEqual(parseKeywords('  huskies  dogs \n\n\nHUSKIES DOGS\n , '), ['huskies dogs']);
});

test('parseKeywords caps the batch', () => {
  const many = Array.from({ length: 250 }, (_, i) => `keyword ${i}`).join('\n');
  assert.equal(parseKeywords(many).length, 100);
  assert.equal(parseKeywords(many, 10).length, 10);
});

test('parseKeywords tolerates rubbish input', () => {
  assert.deepEqual(parseKeywords(null), []);
  assert.deepEqual(parseKeywords(''), []);
  assert.deepEqual(parseKeywords(undefined), []);
});

test('apexOf strips subdomains and www', () => {
  assert.equal(apexOf('www.example.com'), 'example.com');
  assert.equal(apexOf('blog.example.com'), 'example.com');
  assert.equal(apexOf('example.com'), 'example.com');
});

test('isCandidateLink rejects the platforms and keeps ordinary sites', () => {
  assert.equal(isCandidateLink('https://huskyblog.net/post/1'), true);
  assert.equal(isCandidateLink('https://www.reddit.com/r/husky'), false);
  assert.equal(isCandidateLink('https://youtube.com/watch?v=1'), false);
  assert.equal(isCandidateLink('https://en.wikipedia.org/wiki/Husky'), false);
});

test('isCandidateLink keeps a blog platform subdomain but drops its apex', () => {
  // someone.substack.com is exactly what discovery is for; substack.com is not.
  assert.equal(isCandidateLink('https://huskies.substack.com/p/hello'), true);
  assert.equal(isCandidateLink('https://substack.com/pricing'), false);
  assert.equal(isCandidateLink('https://www.medium.com/'), false);
});

test('isCandidateLink rejects non-pages and non-http schemes', () => {
  assert.equal(isCandidateLink('https://example.com/guide.pdf'), false);
  assert.equal(isCandidateLink('https://example.com/photo.JPG'), false);
  assert.equal(isCandidateLink('ftp://example.com/x'), false);
  assert.equal(isCandidateLink('not a url'), false);
});

test('candidateSites collapses many results from one host to one site root', () => {
  const sites = candidateSites([
    {
      ok: true,
      keyword: 'siberian huskies',
      links: [
        'https://huskyblog.net/post/1',
        'https://huskyblog.net/post/2',
        'https://www.huskyblog.net/about',
      ],
    },
  ]);

  assert.equal(sites.length, 1);
  // The root, not the ranked article: that is where <link rel="alternate"> lives.
  assert.equal(sites[0].url, 'https://huskyblog.net/');
  assert.equal(sites[0].host, 'huskyblog.net');
  assert.equal(sites[0].keyword, 'siberian huskies');
});

test('candidateSites keeps the first keyword that surfaced a host', () => {
  const sites = candidateSites([
    { ok: true, keyword: 'huskies', links: ['https://dogs.example/a'] },
    { ok: true, keyword: 'malamutes', links: ['https://dogs.example/b'] },
  ]);

  assert.equal(sites.length, 1);
  assert.equal(sites[0].keyword, 'huskies');
});

test('candidateSites ignores failed searches', () => {
  const sites = candidateSites([
    { ok: false, keyword: 'huskies', error: 'quota-exhausted' },
    { ok: true, keyword: 'dogs', links: ['https://dogs.example/a'] },
  ]);

  assert.deepEqual(
    sites.map((s) => s.host),
    ['dogs.example'],
  );
});
