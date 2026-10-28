import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMMANDS, run } from '../src/index.js';

/**
 * @param {(url: string, init?: RequestInit) => Response|Promise<Response>} handler
 * @param {() => Promise<void>} body
 */
async function withFetch(handler, body) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

const io = (out) => ({ log: (s) => out.push(s), error: (s) => out.push(`ERR ${s}`) });

test('webhooks is documented like every other command', () => {
  const cmd = COMMANDS.find((c) => c.name === 'webhooks');
  assert.ok(cmd);
  assert.ok(cmd.options.includes('--token <key>'));
});

test('webhooks needs an API key before it asks anything', async () => {
  const out = [];
  const saved = process.env['RSSAMPLIFIER_TOKEN'];
  delete process.env['RSSAMPLIFIER_TOKEN'];
  try {
    await withFetch(
      () => assert.fail('no request without a key'),
      async () => assert.equal(await run(['webhooks', '--api', 'http://t.example'], io(out)), 1),
    );
  } finally {
    if (saved !== undefined) process.env['RSSAMPLIFIER_TOKEN'] = saved;
  }
  assert.match(out.join('\n'), /needs an API key/);
});

test('webhooks add posts to /api/v1/webhooks with the key and prints the secret', async () => {
  const out = [];
  await withFetch(
    (url, init) => {
      assert.equal(url, 'http://t.example/api/v1/webhooks');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, 'Bearer rsa_test');
      assert.deepEqual(JSON.parse(String(init.body)), {
        url: 'https://hooks.example.com/x',
        events: ['posts.published'],
        description: 'relay',
      });
      return new Response(
        JSON.stringify({ endpoint: { id: 'wh_1', url: 'https://hooks.example.com/x', events: ['posts.published'] }, secret: 'whsec_abc' }),
        { status: 201 },
      );
    },
    async () => {
      const code = await run(
        ['webhooks', 'add', 'https://hooks.example.com/x', '--events', 'posts.published', '--description', 'relay', '--token', 'rsa_test', '--api', 'http://t.example'],
        io(out),
      );
      assert.equal(code, 0);
    },
  );
  assert.match(out.join('\n'), /whsec_abc/);
});

test('webhooks test and deliveries hit their routes', async () => {
  const urls = [];
  await withFetch(
    (url) => {
      urls.push(url);
      if (url.endsWith('/test')) return new Response(JSON.stringify({ ok: true, status: 204, error: null }), { status: 200 });
      return new Response(JSON.stringify({ deliveries: [] }), { status: 200 });
    },
    async () => {
      const out = [];
      assert.equal(await run(['webhooks', 'test', 'wh_1', '--token', 'rsa_t', '--api', 'http://t.example'], io(out)), 0);
      assert.equal(await run(['webhooks', 'deliveries', '--token', 'rsa_t', '--api', 'http://t.example'], io(out)), 0);
      assert.match(out.join('\n'), /Delivered \(HTTP 204\)/);
    },
  );
  assert.deepEqual(urls, ['http://t.example/api/v1/webhooks/wh_1/test', 'http://t.example/api/v1/webhooks/deliveries']);
});
