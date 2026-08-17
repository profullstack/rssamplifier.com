import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  COMMANDS,
  DEFAULT_API,
  VERSION,
  apiBase,
  feedUrlsFromOpml,
  helpText,
  parseArgs,
  run,
  truncate,
} from '../src/index.js';

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

test('the reported version is the published version', async () => {
  // --version is what people paste into a bug report, and a hardcoded string
  // that drifts from package.json makes every one of those reports wrong.
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('help lists every command, and every command is dispatchable', async () => {
  const help = helpText();
  for (const command of COMMANDS) {
    assert.ok(help.includes(command.usage), `${command.name} is missing from --help`);
  }

  // The docs page renders COMMANDS verbatim, so a command described there and
  // absent from the switch would be documented and dead. Reaching the default
  // branch is what that failure looks like from here.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    for (const command of COMMANDS) {
      const errs = [];
      await run([command.name, 'x', '--api', 'http://t.example'], {
        log: () => {},
        error: (s) => errs.push(s),
      });
      assert.ok(
        !errs.join(' ').includes('Unknown command'),
        `${command.name} is documented but not dispatched`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('feedUrlsFromOpml pulls out xmlUrl and unescapes it', () => {
  const opml = `<opml><body>
    <outline text="A" xmlUrl="https://a.example/feed.xml" htmlUrl="https://a.example/" />
    <outline text="B" xmlUrl="https://b.example/feed?a=1&amp;b=2" />
  </body></opml>`;

  assert.deepEqual(feedUrlsFromOpml(opml), [
    'https://a.example/feed.xml',
    // htmlUrl must not be collected, and the entity must come back as one '&'.
    'https://b.example/feed?a=1&b=2',
  ]);
  assert.deepEqual(feedUrlsFromOpml('<opml/>'), []);
});

test('urls asks /opml with the filters and prints one URL per line', async () => {
  const originalFetch = globalThis.fetch;
  let asked = null;

  globalThis.fetch = async (url) => {
    asked = String(url);
    return new Response(
      '<opml><body><outline xmlUrl="https://a.example/feed" /></body></opml>',
      { status: 200 },
    );
  };

  const out = [];
  try {
    const code = await run(['urls', '--topic', 'homelab', '--api', 'http://t.example'], {
      log: (s) => out.push(s),
      error: () => {},
    });
    assert.equal(code, 0);
    assert.equal(asked, 'http://t.example/opml?topic=homelab');
    assert.deepEqual(out, ['https://a.example/feed']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('urls exits non-zero when the filters matched nothing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<opml><body></body></opml>', { status: 200 });

  try {
    // An empty export is almost always a topic that does not exist. Printing
    // nothing and exiting zero tells a script the topic is empty, which is a
    // different and wrong answer.
    const code = await run(['urls', '--topic', 'nope', '--api', 'http://t.example'], {
      log: () => {},
      error: () => {},
    });
    assert.equal(code, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('topics searches when given a term and finding nothing is not an error', async () => {
  const originalFetch = globalThis.fetch;
  let asked = null;

  globalThis.fetch = async (url) => {
    asked = String(url);
    return new Response(JSON.stringify({ total: 0, topics: [] }), { status: 200 });
  };

  try {
    const code = await run(['topics', 'home', 'lab', '--api', 'http://t.example'], {
      log: () => {},
      error: () => {},
    });
    assert.equal(code, 0, 'a subject the directory does not cover is an answer, not a failure');
    assert.ok(asked.includes('q=home+lab'), `multi-word query was not joined: ${asked}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('topic requires a keyword and points at how to find one', async () => {
  const errs = [];
  assert.equal(await run(['topic'], { log: () => {}, error: (s) => errs.push(s) }), 1);
  assert.match(errs.join(' '), /rssamp topics/);
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
