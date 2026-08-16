import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseArgs, apiBase, truncate, run, DEFAULT_API } from '../src/index.js';

test('parseArgs separates command, positionals and flags', () => {
  const r = parseArgs(['submit', 'a.com', 'b.com', '--json']);
  assert.equal(r.command, 'submit');
  assert.deepEqual(r.args, ['a.com', 'b.com']);
  assert.equal(r.flags.json, true);
});

test('parseArgs reads flag values but treats a trailing flag as boolean', () => {
  const withValue = parseArgs(['list', '--limit', '10']);
  assert.equal(withValue.flags.limit, '10');

  // --json must not swallow the next flag as its value.
  const twoFlags = parseArgs(['list', '--json', '--limit', '5']);
  assert.equal(twoFlags.flags.json, true);
  assert.equal(twoFlags.flags.limit, '5');

  const trailing = parseArgs(['list', '--limit']);
  assert.equal(trailing.flags.limit, true);
});

test('apiBase prefers --api, then env, then the default, and strips slashes', () => {
  assert.equal(apiBase({ api: 'http://localhost:3000/' }, {}), 'http://localhost:3000');
  assert.equal(apiBase({}, { RSSAMP_API: 'https://staging.example//' }), 'https://staging.example');
  assert.equal(apiBase({}, {}), DEFAULT_API);
});

test('truncate collapses whitespace and adds an ellipsis', () => {
  assert.equal(truncate('a   b\n c', 40), 'a b c');
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(truncate(null, 5), '');
});

test('help exits zero, unknown command exits non-zero', async () => {
  const out = [];
  assert.equal(await run(['--help'], { log: (s) => out.push(s), error: () => {} }), 0);
  assert.ok(out.join('\n').includes('rssamplifier'));

  assert.equal(await run(['frobnicate'], { log: () => {}, error: () => {} }), 1);
});

test('submit with no arguments is an error', async () => {
  const errs = [];
  const code = await run(['submit'], { log: () => {}, error: (s) => errs.push(s) });
  assert.equal(code, 1);
  assert.match(errs.join(' '), /at least one URL/);
});

test('search with no query is an error', async () => {
  const errs = [];
  assert.equal(await run(['search'], { log: () => {}, error: (s) => errs.push(s) }), 1);
  assert.match(errs.join(' '), /give a query/);
});

test('submit routes an .opml argument to a file read', async () => {
  let readPath = null;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    assert.equal(payload.opml, '<opml/>', 'file contents are sent, not the path');
    assert.ok(String(url).endsWith('/api/submit'));
    return new Response(JSON.stringify({ ok: true, accepted: [{ slug: 'x', existing: false }] }), {
      status: 200,
    });
  };

  try {
    const code = await run(['submit', 'subs.opml', '--api', 'http://t.example'], {
      log: () => {},
      error: () => {},
      readFile: async (p) => {
        readPath = p;
        return '<opml/>';
      },
    });
    assert.equal(code, 0);
    assert.equal(readPath, 'subs.opml');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('submit exits non-zero when nothing was accepted', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, accepted: [], rejected: [{ url: 'x', error: 'no-feed-found' }] }), {
      status: 200,
    });

  try {
    const code = await run(['submit', 'nope.example', '--api', 'http://t.example'], {
      log: () => {},
      error: () => {},
    });
    assert.equal(code, 1, 'a fully rejected submission must not report success');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
