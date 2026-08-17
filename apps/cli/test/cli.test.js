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
  installPath,
  looksLikeThisProgram,
  parseArgs,
  run,
  truncate,
  versionOf,
} from '../src/index.js';

/**
 * A stand-in for a copy of the program on disk, long enough to pass the
 * size check that keeps an HTML error page from being installed as one.
 *
 * @param {string} version
 * @returns {string}
 */
function fakeProgram(version) {
  return `#!/usr/bin/env node\n// rssamplifier CLI\nexport const VERSION = '${version}';\n${'//x\n'.repeat(700)}`;
}

/**
 * A filesystem that lives in a Map, so update and remove can be driven without
 * an install to break.
 *
 * @param {Record<string, string>} files
 * @param {string} [selfPath] what every realpath resolves to, which is how a
 *   test says "the running program is this installed file"
 */
function fakeFs(files, selfPath) {
  const store = new Map(Object.entries(files));
  return {
    store,
    readFile: async (p) => {
      if (!store.has(p)) throw new Error(`ENOENT: ${p}`);
      return store.get(p);
    },
    writeFile: async (p, data) => void store.set(p, data),
    chmod: async () => {},
    rename: async (from, to) => {
      store.set(to, store.get(from));
      store.delete(from);
    },
    unlink: async (p) => void store.delete(p),
    realpath: async (p) => selfPath ?? p,
  };
}

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

test('looksLikeThisProgram rejects what a captive portal would serve', () => {
  assert.ok(looksLikeThisProgram(fakeProgram('1.0.0')));
  // The failure this exists for: a proxy answering 200 with an error page.
  assert.equal(looksLikeThisProgram('<!doctype html><title>Sign in to wifi</title>'), false);
  assert.equal(looksLikeThisProgram('#!/usr/bin/env node\nconsole.log(1)\n'), false, 'too short');
  assert.equal(looksLikeThisProgram(`// rssamplifier\n${'//x\n'.repeat(700)}`), false, 'no shebang');
  assert.equal(looksLikeThisProgram(''), false);
});

test('versionOf reads the version out of a copy', () => {
  assert.equal(versionOf(fakeProgram('9.9.9')), '9.9.9');
  assert.equal(versionOf('nothing here'), null);
});

test('installPath only claims a curl-installed copy', async () => {
  // Running the installed file: every realpath lands on it, and it is called
  // one of the names the installer writes.
  const installed = '/home/u/.local/bin/rssamp';
  assert.equal(await installPath(fakeFs({}, installed), installed), installed);

  // Imported rather than run — an npm install. The running path and the
  // module's own path differ, so there is nothing to update in place.
  assert.equal(await installPath(fakeFs({}), '/home/u/project/node_modules/.bin/rssamp'), null);

  // Run out of a checkout under its own filename. This is the guard that stops
  // `node src/index.js remove` deleting somebody's working copy.
  const checkout = '/home/u/src/rssamplifier/apps/cli/src/index.js';
  assert.equal(await installPath(fakeFs({}, checkout), checkout), null);

  assert.equal(await installPath(fakeFs({}), undefined), null);
});

test('update and remove decline when this is not an install', async () => {
  for (const command of ['update', 'remove']) {
    const errs = [];
    const code = await run([command, '--yes'], {
      log: () => {},
      error: (s) => errs.push(s),
      fs: fakeFs({}),
      argv1: '/home/u/node_modules/.bin/rssamp',
    });
    assert.equal(code, 1, `${command} must not act on a non-install`);
    assert.match(errs.join(' '), /not a curl-installed copy/);
  }
});

test('update replaces both installed names and reports the change', async () => {
  const bin = '/home/u/.local/bin';
  const self = `${bin}/rssamp`;
  const fs = fakeFs(
    { [self]: fakeProgram('0.0.1'), [`${bin}/rssamplifier`]: fakeProgram('0.0.1') },
    self,
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(fakeProgram('9.9.9'), { status: 200 });

  const out = [];
  try {
    const code = await run(['update'], { log: (s) => out.push(s), error: () => {}, fs, argv1: self });
    assert.equal(code, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(versionOf(fs.store.get(self)), '9.9.9');
  assert.equal(versionOf(fs.store.get(`${bin}/rssamplifier`)), '9.9.9', 'the alias updates too');
  // Staged beside the target and renamed over it; the staging file must not
  // survive as litter in the user's bin directory.
  assert.equal(fs.store.has(`${bin}/.rssamp.update`), false);
  assert.match(out.join('\n'), /9\.9\.9/);
});

test('update refuses to install something that is not the program', async () => {
  const self = '/home/u/.local/bin/rssamp';
  const before = fakeProgram('0.0.1');
  const fs = fakeFs({ [self]: before }, self);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<!doctype html><title>wifi</title>', { status: 200 });

  const errs = [];
  try {
    const code = await run(['update'], { log: () => {}, error: (s) => errs.push(s), fs, argv1: self });
    assert.equal(code, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fs.store.get(self), before, 'a bad download must leave the working copy alone');
  assert.match(errs.join(' '), /did not return the CLI/);
});

test('update says so and changes nothing when already current', async () => {
  const self = '/home/u/.local/bin/rssamp';
  const fs = fakeFs({ [self]: fakeProgram(VERSION) }, self);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(fakeProgram(VERSION), { status: 200 });

  const out = [];
  try {
    assert.equal(
      await run(['update'], { log: (s) => out.push(s), error: () => {}, fs, argv1: self }),
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(out.join(' '), /Already on/);
});

test('remove is a dry run until --yes, then deletes only its own files', async () => {
  const bin = '/home/u/.local/bin';
  const self = `${bin}/rssamp`;
  const files = {
    [self]: fakeProgram('0.3.0'),
    [`${bin}/rssamplifier`]: fakeProgram('0.3.0'),
  };

  const dry = fakeFs({ ...files }, self);
  const out = [];
  assert.equal(await run(['remove'], { log: (s) => out.push(s), error: () => {}, fs: dry, argv1: self }), 0);
  assert.equal(dry.store.size, 2, 'nothing is deleted without --yes');
  assert.match(out.join('\n'), /Would remove/);

  const wet = fakeFs({ ...files }, self);
  assert.equal(
    await run(['remove', '--yes'], { log: () => {}, error: () => {}, fs: wet, argv1: self }),
    0,
  );
  assert.equal(wet.store.size, 0);
});

test('remove leaves somebody else\'s rssamp alone', async () => {
  const bin = '/usr/local/bin';
  const self = `${bin}/rssamp`;
  // A different tool that happens to share the alias. Deleting it would be the
  // worst thing this command could do.
  const stranger = '#!/bin/sh\necho "a different rssamplifier-shaped tool"\n';
  const fs = fakeFs({ [self]: fakeProgram('0.3.0'), [`${bin}/rssamplifier`]: stranger }, self);

  assert.equal(
    await run(['remove', '--yes'], { log: () => {}, error: () => {}, fs, argv1: self }),
    0,
  );
  assert.equal(fs.store.get(`${bin}/rssamplifier`), stranger, 'a foreign file is never deleted');
  assert.equal(fs.store.has(self), false);
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
