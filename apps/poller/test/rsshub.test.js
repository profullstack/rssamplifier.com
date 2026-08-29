import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';

import { startRsshub, shouldRunRsshub, authTokens } from '../src/rsshub.js';

/*
 * The supervisor, which is the half of this that can be tested without building
 * an image. What it must guarantee: RSSHub crashing costs a restart and nothing
 * else, a deploy does not leave it respawning into a container that is going
 * away, and the X session cookie never reaches a log line.
 */

/** A child process that does nothing until told to die. */
function fakeChild(pid = 1234) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.killed = signal;
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  return child;
}

/** A spawn that hands back children from a list and records how it was called. */
function fakeSpawn(children) {
  const calls = [];
  let n = 0;
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return children[Math.min(n++, children.length - 1)];
  };
  spawn.calls = calls;
  return spawn;
}

test('the daemon is started with loopback, a fixed port and an in-memory cache', () => {
  const spawn = fakeSpawn([fakeChild()]);
  const handle = startRsshub({ env: {}, spawn, log: () => {} });

  assert.equal(handle.url, 'http://127.0.0.1:1200');

  const { args, opts } = spawn.calls[0];

  // The three values that were wrong on the first attempt, and that produce a
  // daemon which builds and deploys and then does not work:
  //
  //   entry — RSSHub publishes no `bin`; their own image starts `dist/index.mjs`
  //           through an npm script. `lib/index.js` was a guess and is not there.
  //   cwd   — it resolves routes relative to the application root, not the entry.
  //   header size — X sends responses whose headers exceed Node's 16KB default,
  //           and the failure reads like a broken upstream rather than our limit.
  assert.equal(args[0], '/opt/rsshub/dist/index.mjs');
  assert.equal(opts.cwd, '/opt/rsshub');
  assert.match(opts.env.NODE_OPTIONS, /--max-http-header-size=32768/);

  assert.equal(opts.env.PORT, '1200');
  assert.equal(opts.env.LISTEN_INADDR_ANY, '0');
  // Redis in this project is the crawler's write queue, not a route cache.
  assert.equal(opts.env.CACHE_TYPE, 'memory');
});

test('our X_SESSIONS becomes the spelling RSSHub wants', () => {
  const env = { X_SESSIONS: '[{"id":"x-1","authToken":"aaa","ct0":"bbb"},{"id":"x-2","authToken":"ccc","ct0":"ddd"}]' };
  assert.equal(authTokens(env), 'aaa,ccc');

  // The flat form still works, and a malformed X_SESSIONS falls back to it
  // rather than stopping the crawler from booting.
  assert.equal(authTokens({ X_AUTH_TOKENS: 'zzz' }), 'zzz');
  assert.equal(authTokens({ X_SESSIONS: '{oops', X_AUTH_TOKENS: 'zzz' }), 'zzz');
  assert.equal(authTokens({}), '');
});

test('a crash is restarted, and the log carries no credential', async () => {
  const first = fakeChild(1);
  const second = fakeChild(2);
  const spawn = fakeSpawn([first, second]);

  const lines = [];
  let clock = 0;

  startRsshub({
    env: { X_SESSIONS: '[{"id":"x-1","authToken":"SUPERSECRET","ct0":"CT0SECRET"}]' },
    spawn,
    now: () => clock,
    log: (event, fields) => lines.push({ event, fields }),
  });

  first.stderr.emit('data', 'Error: something went wrong\n');
  clock += 500;
  first.emit('exit', 1, null);

  await new Promise((resolve) => setTimeout(resolve, 5));

  const exited = lines.find((line) => line.event === 'rsshub-exited');
  assert.ok(exited, 'a crash is reported');
  assert.equal(exited.fields.failures, 1);
  assert.ok(exited.fields.restartInMs > 0, 'and a restart is scheduled');

  // The token is in the child's environment and must be in nothing else.
  assert.doesNotMatch(JSON.stringify(lines), /SUPERSECRET|CT0SECRET/);
});

test('a long healthy run resets the backoff', async () => {
  const children = [fakeChild(1), fakeChild(2)];
  const spawn = fakeSpawn(children);
  const lines = [];
  let clock = 0;

  startRsshub({ env: {}, spawn, now: () => clock, log: (event, fields) => lines.push({ event, fields }) });

  // Ran for an hour, then died: that is not a crash loop.
  clock += 3_600_000;
  children[0].emit('exit', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const exited = lines.filter((line) => line.event === 'rsshub-exited');
  assert.equal(exited.at(-1).fields.failures, 1);
  assert.equal(exited.at(-1).fields.restartInMs, 1_000, 'back to the shortest backoff');
});

test('stopping does not respawn — a deploy must not fight the supervisor', async () => {
  const child = fakeChild();
  const spawn = fakeSpawn([child, fakeChild(2)]);

  const handle = startRsshub({ env: {}, spawn, log: () => {} });
  await handle.stop();

  assert.equal(child.killed, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawn.calls.length, 1, 'exactly one spawn, and no restart after stop');
});

test('who runs the daemon, and who does not', () => {
  // X off: nothing to collect, so no daemon.
  assert.equal(shouldRunRsshub({ X_ENABLED: 'false' }), false);
  assert.equal(shouldRunRsshub({}), false);

  // X on and nothing else said: this process runs it.
  assert.equal(shouldRunRsshub({ X_ENABLED: 'true' }), true);

  // Somebody has pointed us at an instance they run. Taking that over would be
  // surprising, and would put a second RSSHub on the same X sessions.
  assert.equal(shouldRunRsshub({ X_ENABLED: 'true', RSSHUB_BASE_URL: 'http://rsshub:1200' }), false);

  // And an explicit opt-out, for a deployment that wants X on with no daemon.
  assert.equal(shouldRunRsshub({ X_ENABLED: 'true', RSSHUB_EMBEDDED: 'false' }), false);
});

test('the handle reports what it is doing', () => {
  const child = fakeChild(4242);
  const handle = startRsshub({ env: {}, spawn: fakeSpawn([child]), log: () => {} });

  assert.deepEqual(handle.state(), {
    running: true,
    pid: 4242,
    failures: 0,
    url: 'http://127.0.0.1:1200',
  });
});
