import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMMANDS, run } from '../src/index.js';

const MD = '# Ada Lovelace\n\n- Kind: person\n\nHost.\n';

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

test('profile is documented like every other command', () => {
  const cmd = COMMANDS.find((c) => c.name === 'profile');
  assert.ok(cmd);
  assert.match(cmd.usage, /profile <slug>/);
  assert.ok(cmd.options.includes('--token <key>'));
});

test('profile <slug> prints the file as served', async () => {
  const out = [];
  await withFetch(
    (url) => {
      assert.equal(url, 'http://t.example/api/authors/ada-lovelace/openprofile');
      return new Response(MD, { status: 200, headers: { 'content-type': 'text/markdown' } });
    },
    async () => {
      const code = await run(['profile', 'ada-lovelace', '--api', 'http://t.example'], { log: (s) => out.push(s), error: () => {} });
      assert.equal(code, 0);
      assert.equal(out.join('\n'), MD.replace(/\n$/, ''));
    },
  );
});

test('profile --feed looks the owner up by feed URL first', async () => {
  const urls = [];
  await withFetch(
    (url) => {
      urls.push(url);
      if (url.includes('/api/authors?feed=')) {
        return new Response(JSON.stringify({ found: true, authors: [{ slug: 'ada-lovelace' }] }), { status: 200 });
      }
      return new Response(MD, { status: 200 });
    },
    async () => {
      const code = await run(['profile', '--feed', 'https://ada.example/podcast/feed.xml', '--api', 'http://t.example'], { log: () => {}, error: () => {} });
      assert.equal(code, 0);
      assert.equal(urls[0], 'http://t.example/api/authors?feed=https%3A%2F%2Fada.example%2Fpodcast%2Ffeed.xml');
      assert.equal(urls[1], 'http://t.example/api/authors/ada-lovelace/openprofile');
    },
  );
});

test('claim and edit refuse to run without a credential, and say where to get one', async () => {
  const errs = [];
  const prev = { a: process.env['RSSAMPLIFIER_TOKEN'], b: process.env['OPENACCESS_TOKEN'] };
  delete process.env['RSSAMPLIFIER_TOKEN'];
  delete process.env['OPENACCESS_TOKEN'];
  try {
    assert.equal(await run(['profile', 'claim', 'ada-lovelace'], { log: () => {}, error: (s) => errs.push(s) }), 1);
    assert.match(errs.join(' '), /--token|RSSAMPLIFIER_TOKEN/);
  } finally {
    if (prev.a !== undefined) process.env['RSSAMPLIFIER_TOKEN'] = prev.a;
    if (prev.b !== undefined) process.env['OPENACCESS_TOKEN'] = prev.b;
  }
});

test('profile edit --file sends the file as Markdown with the bearer', async () => {
  let seen = null;
  await withFetch(
    (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true, url: 'http://t.example/authors/ada-lovelace/openprofile.md' }), { status: 200 });
    },
    async () => {
      const out = [];
      const code = await run(
        ['profile', 'edit', 'ada-lovelace', '--file', 'p.md', '--token', 'rsa_x_y', '--api', 'http://t.example'],
        { log: (s) => out.push(s), error: () => {}, readFile: async () => MD },
      );
      assert.equal(code, 0);
      assert.equal(seen.init.method, 'PUT');
      assert.equal(seen.init.headers.authorization, 'Bearer rsa_x_y');
      assert.match(seen.init.headers['content-type'], /text\/markdown/);
      assert.equal(seen.init.body, MD);
      assert.match(out.join(' '), /Saved/);
    },
  );
});

test('profile edit through the editor sends only when something changed', async () => {
  const calls = [];
  await withFetch(
    (url, init) => {
      calls.push(init?.method ?? 'GET');
      if (!init?.method) return new Response(MD, { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    async () => {
      const out = [];
      const unchanged = await run(['profile', 'edit', 'ada-lovelace', '--token', 't', '--api', 'http://t.example'], {
        log: (s) => out.push(s),
        error: () => {},
        edit: async (text) => text,
      });
      assert.equal(unchanged, 0);
      assert.deepEqual(calls, ['GET']);
      assert.match(out.join(' '), /Unchanged/);

      const changed = await run(['profile', 'edit', 'ada-lovelace', '--token', 't', '--api', 'http://t.example'], {
        log: () => {},
        error: () => {},
        edit: async (text) => `${text}\n## Guest\n\n- **Available**: yes\n`,
      });
      assert.equal(changed, 0);
      assert.deepEqual(calls, ['GET', 'GET', 'PUT']);
    },
  );
});

test('claim posts to the claim route and reports the method', async () => {
  const out = [];
  await withFetch(
    (url, init) => {
      assert.equal(url, 'http://t.example/api/authors/ada-lovelace/claim');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, 'Bearer t');
      return new Response(JSON.stringify({ ok: true, method: 'linkback' }), { status: 200 });
    },
    async () => {
      assert.equal(await run(['profile', 'claim', 'ada-lovelace', '--token', 't', '--api', 'http://t.example'], { log: (s) => out.push(s), error: () => {} }), 0);
      assert.match(out.join(' '), /linkback/);
    },
  );
});
