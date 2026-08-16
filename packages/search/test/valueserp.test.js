import test from 'node:test';
import assert from 'node:assert/strict';

import { searchKeyword, FATAL_ERRORS } from '../index.js';

/**
 * A fetch stand-in. Records the URLs it was called with so the query string can
 * be asserted without going anywhere near the network.
 *
 * @param {(url: URL) => { status?: number, body?: object }} handler
 */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url) => {
    calls.push(new URL(String(url)));
    const { status = 200, body = {} } = handler(new URL(String(url))) ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

test('searchKeyword returns organic links', async () => {
  const fetchImpl = stubFetch(() => ({
    body: {
      organic_results: [
        { link: 'https://a.example/1' },
        { link: 'https://b.example/2' },
        { position: 3 }, // no link — must not become undefined in the output
      ],
    },
  }));

  const res = await searchKeyword('siberian huskies', { apiKey: 'k', pages: 1, fetchImpl });

  assert.equal(res.ok, true);
  assert.deepEqual(res.links, ['https://a.example/1', 'https://b.example/2']);
});

test('searchKeyword sends the keyword and a page number', async () => {
  const fetchImpl = stubFetch(() => ({ body: { organic_results: [] } }));
  await searchKeyword('siberian huskies', { apiKey: 'secret', pages: 1, fetchImpl });

  const url = fetchImpl.calls[0];
  assert.equal(url.searchParams.get('q'), 'siberian huskies');
  assert.equal(url.searchParams.get('api_key'), 'secret');
  assert.equal(url.searchParams.get('page'), '1');
  // The old script pinned time_period=last_month, which hides every blog that
  // did not post in the last four weeks.
  assert.equal(url.searchParams.has('time_period'), false);
});

test('searchKeyword pages, because num is ignored by the engine', async () => {
  // Measured against the live API: num=100 returns eight results, and page two
  // is a completely different set. Paging is the only way to see more.
  const pages = {
    1: ['https://a.example/1', 'https://b.example/2'],
    2: ['https://c.example/3', 'https://a.example/1'],
    3: ['https://d.example/4'],
  };
  const fetchImpl = stubFetch((url) => ({
    body: { organic_results: (pages[url.searchParams.get('page')] ?? []).map((link) => ({ link })) },
  }));

  const res = await searchKeyword('dogs', { apiKey: 'k', pages: 3, fetchImpl });

  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(res.pages, 3);
  // Deduped across pages: page two repeated one of page one's links.
  assert.deepEqual(res.links, [
    'https://a.example/1',
    'https://b.example/2',
    'https://c.example/3',
    'https://d.example/4',
  ]);
});

test('searchKeyword stops paging at an empty page rather than spending credits', async () => {
  const fetchImpl = stubFetch((url) => ({
    body: {
      organic_results:
        url.searchParams.get('page') === '1' ? [{ link: 'https://only.example/' }] : [],
    },
  }));

  const res = await searchKeyword('dogs', { apiKey: 'k', pages: 5, fetchImpl });

  assert.equal(fetchImpl.calls.length, 2, 'one real page, one empty, then stop');
  assert.deepEqual(res.links, ['https://only.example/']);
});

test('a later page failing truncates instead of losing the keyword', async () => {
  const fetchImpl = stubFetch((url) =>
    url.searchParams.get('page') === '1'
      ? { body: { organic_results: [{ link: 'https://kept.example/' }] } }
      : { status: 500 },
  );

  const res = await searchKeyword('dogs', { apiKey: 'k', pages: 3, fetchImpl });

  assert.equal(res.ok, true);
  assert.deepEqual(res.links, ['https://kept.example/']);
});

test('searchKeyword maps provider statuses to stable codes', async () => {
  const cases = [
    [402, 'quota-exhausted'],
    [401, 'bad-api-key'],
    [403, 'bad-api-key'],
    [429, 'rate-limited'],
    [500, 'http-500'],
  ];

  for (const [status, expected] of cases) {
    const fetchImpl = stubFetch(() => ({ status }));
    const res = await searchKeyword('x', { apiKey: 'k', pages: 1, fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.error, expected, `status ${status}`);
  }
});

test('searchKeyword refuses without a key rather than calling out', async () => {
  const fetchImpl = stubFetch(() => ({ body: {} }));
  const res = await searchKeyword('x', { apiKey: '', fetchImpl });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'no-api-key');
  assert.equal(fetchImpl.calls.length, 0);
});

test('searchKeyword rejects an empty keyword', async () => {
  const res = await searchKeyword('   ', { apiKey: 'k' });
  assert.equal(res.error, 'empty-keyword');
});

test('the fatal set is the three that mean "stop"', () => {
  assert.deepEqual([...FATAL_ERRORS].sort(), ['bad-api-key', 'no-api-key', 'quota-exhausted']);
});
