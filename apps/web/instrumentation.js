/**
 * Lift Node's cap on how long a request may take to arrive.
 *
 * `http.Server` defaults `requestTimeout` to five minutes and answers 408 the
 * moment it passes — measured from the first byte of the request, so it is a
 * cap on the upload itself and not on any handler. Next never sets the option
 * and `next start` exposes no flag for it, so an OPML import larger than a few
 * hundred megabytes was killed mid-stream: a 600 MiB catalogue measured here
 * queued 739,000 feeds and was then cut off at 325 seconds with the connection
 * reset and the submission left unfinished.
 *
 * The default exists to stop a slowloris holding a socket open forever. That is
 * a real concern and the reason this raises the ceiling rather than removing it
 * (`0` disables the timeout entirely, which is how you acquire the attack the
 * default was written to prevent). Six hours is chosen against the endpoint's
 * own ceiling: 10 GiB at the write throughput measured here is a few hours of
 * legitimate work, and anything still trickling after six is not an import.
 *
 * Patching `createServer` is not elegant. The alternative is a custom server
 * file, which would mean owning Next's bootstrap and changing how the service
 * is started, for one option — see `docs/uploads.md`.
 */

/** How long a single request may take to arrive, in milliseconds. */
const REQUEST_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Long uploads also go quiet between chunks on a slow link, and `headersTimeout`
 * governs only the headers — but keep-alive reaping is what closes an idle
 * socket, so it is raised in step rather than left at a minute.
 */
const KEEP_ALIVE_TIMEOUT_MS = 10 * 60 * 1000;

export async function register() {
  // Only the Node runtime has an HTTP server to configure; the edge runtime
  // imports this file too and has neither.
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  // The specifiers are built rather than written, so the bundler cannot see a
  // node: import to warn about while preparing the edge runtime — which never
  // reaches this line, having returned above.
  const node = (name) => import(/* turbopackIgnore: true */ /* webpackIgnore: true */ `node:${name}`);

  const http = await node('http');
  const https = await node('https');

  for (const mod of [http.default ?? http, https.default ?? https]) {
    const original = mod.createServer;
    if (typeof original !== 'function' || original.__rssamplifierPatched) continue;

    /** @type {any} */
    const patched = function createServer(...args) {
      const server = original.apply(this, args);

      // Assigned after construction rather than merged into the options
      // argument: the caller may pass a listener as the first argument, a
      // handler object as the second, or neither, and guessing which overload
      // Next is using is how this breaks on an upgrade.
      server.requestTimeout = REQUEST_TIMEOUT_MS;
      server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

      return server;
    };

    patched.__rssamplifierPatched = true;
    mod.createServer = patched;
  }
}
