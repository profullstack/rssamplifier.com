/**
 * Raise Node's cap on how long a request may take to arrive.
 *
 * Preloaded with `--import` rather than imported by the app, because it has to
 * run before Next builds its HTTP server and there is no hook inside the app
 * that does. `instrumentation.js` looks like the right place and is not: its
 * `register()` fires after `startServer` has already called
 * `http.createServer`, so patching from there logs cheerfully and changes
 * nothing. That was verified by printing from `register()` and watching the
 * line appear *after* "Ready".
 *
 * ## What is actually being fixed
 *
 * `http.Server` defaults `requestTimeout` to 300 seconds and answers `408` when
 * a request takes longer than that to be received — a cap on the upload, not on
 * any handler. Next never sets the option and `next start` exposes no flag for
 * it.
 *
 * The failure it causes is worth describing, because it does not look like a
 * timeout. A large OPML upload is consumed at the speed the importer can write
 * feeds, so once the client is faster than the database — which it is —
 * back-pressure stops the server reading the socket for long stretches. Node
 * sees a request that has not finished arriving and kills it. Measured here: a
 * 600 MiB catalogue queued 739,000 feeds and was then cut off at 332 seconds
 * with `ECONNRESET`, the submission left unfinished. A *slow* upload of the same
 * total duration survives, because data keeps trickling in; it is specifically
 * the fast-client-slow-consumer shape that dies, which is every real import.
 *
 * Six hours is chosen against the endpoint's own ceiling rather than plucked:
 * `OPML_MAX_BYTES` is 10 GiB and the import writes at the speed measured in
 * `docs/uploads.md`, so a legitimate import can genuinely run for hours.
 *
 * It raises the limit rather than removing it. `0` disables the timeout, which
 * is how you reacquire the slowloris the default was written to prevent.
 */
import http from 'node:http';
import https from 'node:https';

/** How long a single request may take to arrive, in milliseconds. */
const REQUEST_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Idle keep-alive sockets are a different thing from a request still arriving,
 * but a minute is stingy for a client that is mid-import.
 */
const KEEP_ALIVE_TIMEOUT_MS = 10 * 60 * 1000;

for (const mod of [http, https]) {
  const original = mod.createServer;

  const patched = function createServer(...args) {
    const server = original.apply(this, args);

    // Assigned after construction rather than merged into an options argument:
    // the caller may pass a listener first, an options object first, or both,
    // and guessing which overload Next is using is how this breaks on an
    // upgrade. Node reads these per connection, so assignment before `listen`
    // is in time.
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

    return server;
  };

  mod.createServer = patched;
}
