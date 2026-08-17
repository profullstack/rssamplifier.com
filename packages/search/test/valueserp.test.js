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

test('searchKeyword asks for ten results a page, not a hundred', async () => {
  // The regression this guards: `num` is the stride `page` walks in, so the
  // upstream offset is (page - 1) * num. num=100 put page two at result 101,
  // past the end of a truncated result set, and every keyword stopped after one
  // page. Measured live — "prepping" returned 9 results at num=100 and 87 at
  // num=10.
  const fetchImpl = stubFetch(() => ({ body: { organic_results: [] } }));
  await searchKeyword('prepping', { apiKey: 'k', pages: 1, fetchImpl });

  assert.equal(fetchImpl.calls[0].searchParams.get('num'), '10');
});

test('searchKeyword pages until it has the target number of results', async () => {
  // Ten unique links a page, so a hundred results is ten pages of work — and it
  // must not stop at the old three-page cap.
  const fetchImpl = stubFetch((url) => {
    const page = Number(url.searchParams.get('page'));
    return {
      body: {
        organic_results: Array.from({ length: 10 }, (_, i) => ({
          link: `https://site${page}-${i}.example/`,
        })),
      },
    };
  });

  const res = await searchKeyword('dogs', { apiKey: 'k', fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(res.links.length, 100, 'a hundred results, not eight');
  // Never more pages than it takes, and never more than the cap.
  assert.ok(fetchImpl.calls.length <= 12, `paged ${fetchImpl.calls.length} times`);
});

test('searchKeyword stops at the target instead of paging on', async () => {
  const fetchImpl = stubFetch((url) => {
    const page = Number(url.searchParams.get('page'));
    return {
      body: {
        organic_results: Array.from({ length: 10 }, (_, i) => ({
          link: `https://site${page}-${i}.example/`,
        })),
      },
    };
  });

  const res = await searchKeyword('dogs', { apiKey: 'k', target: 20, concurrency: 1, fetchImpl });

  assert.equal(res.links.length, 20);
  assert.equal(fetchImpl.calls.length, 2, 'two pages of ten is the target, so stop');
});

test('searchKeyword pages, deduplicating what the pages share', async () => {
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

  const res = await searchKeyword('dogs', { apiKey: 'k', pages: 5, concurrency: 1, fetchImpl });

  assert.equal(fetchImpl.calls.length, 2, 'one real page, one empty, then stop');
  assert.deepEqual(res.links, ['https://only.example/']);
});

test('a wave that runs off the end costs at most its own width', async () => {
  // Pages go out in parallel, so the end of the results is discovered a wave
  // late. What must not happen is a second wave after it.
  const fetchImpl = stubFetch((url) => ({
    body: {
      organic_results:
        url.searchParams.get('page') === '1' ? [{ link: 'https://only.example/' }] : [],
    },
  }));

  const res = await searchKeyword('dogs', { apiKey: 'k', pages: 12, concurrency: 4, fetchImpl });

  assert.equal(fetchImpl.calls.length, 5, 'page one, then one wave of four, then stop');
  assert.deepEqual(res.links, ['https://only.example/']);
});

test('a slow first page is retried before the keyword is given up on', async () => {
  // What killed "smokey mountains" on run c1bb1503: one 20s abort, and a
  // keyword that would have returned ninety results was marked failed.
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ organic_results: [{ link: 'https://kept.example/' }] }),
    };
  };

  const res = await searchKeyword('smokey mountains', {
    apiKey: 'k',
    pages: 1,
    fetchImpl,
  });

  assert.equal(res.ok, true);
  assert.equal(attempts, 2, 'retried once');
  assert.deepEqual(res.links, ['https://kept.example/']);
});

test('a first page that keeps timing out still fails the keyword', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };

  const res = await searchKeyword('dogs', { apiKey: 'k', pages: 1, fetchImpl });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'timeout');
  assert.equal(attempts, 2, 'one retry, not a loop');
});

test('a quota answer on page one is not retried', async () => {
  // Retrying a 402 spends nothing and learns nothing: the plan is dry until it
  // resets.
  const fetchImpl = stubFetch(() => ({ status: 402 }));
  const res = await searchKeyword('dogs', { apiKey: 'k', pages: 1, fetchImpl });

  assert.equal(res.error, 'quota-exhausted');
  assert.equal(fetchImpl.calls.length, 1);
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
