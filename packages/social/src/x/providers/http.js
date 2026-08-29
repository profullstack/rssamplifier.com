/**
 * The one way this package talks to an upstream provider.
 *
 * Shared rather than repeated in each provider because the three things it does
 * are the three things easiest to get subtly wrong once per file: the timeout
 * (a provider that hangs must not hold a crawl worker for the length of a
 * socket timeout), the classification of the reply (§16), and the redaction of
 * the error (§35, §36).
 *
 * **Nothing here ever logs a URL with credentials in it.** RSSHub takes its X
 * cookie as a query parameter in some deployments, so a thrown error carrying
 * `error.url` would put a live session token into the poller's stdout — and
 * from there into Railway's log retention, which is the one place secrets are
 * hardest to withdraw from. `safeUrl()` is what stands between those two facts.
 */

import { classifyResponse, XUnavailable } from '../errors.js';

/** Default upstream deadline (§47: `X_FETCH_TIMEOUT_MS`). */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Cap on a provider response, so a wedged upstream cannot exhaust memory. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * GET a provider URL and hand back the body, or throw one of the four errors.
 *
 * @param {string|URL} url
 * @param {{
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   provider?: string,
 *   sessionId?: string,
 *   fetch?: typeof fetch,
 *   signal?: AbortSignal,
 * }} [opts]
 * @returns {Promise<{ body: string, status: number, headers: Headers, url: string }>}
 */
export async function providerGet(url, opts = {}) {
  const {
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    provider = 'unknown',
    sessionId = null,
    fetch: doFetch = fetch,
    signal,
  } = opts;

  const controller = new AbortController();
  // A ref'd timer, not `AbortSignal.timeout()`. Node 22's test runner cancels a
  // whole file when its only pending work is an unref'd deadline — see
  // packages/db/migrations/README.md's sibling note and the CI memory: the
  // failure reports as `cancelled N, fail 0`, which does not read as a failure.
  const deadline = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await doFetch(String(url), {
      headers: { accept: '*/*', 'user-agent': USER_AGENT, ...headers },
      redirect: 'follow',
      signal: controller.signal,
    });

    const body = await readCapped(res);
    const failure = classifyResponse({
      status: res.status,
      headers: res.headers,
      body,
      provider,
      sessionId,
    });
    if (failure) throw failure;

    // `url` is where the response actually came from after redirects. The
    // Facebook scraper needs it: mbasic answers a missing session with a 302
    // to login.php and a 200 body, so the status alone says nothing.
    return { body, status: res.status, headers: res.headers, url: res.url ?? String(url) };
  } catch (error) {
    if (error?.name?.startsWith('X')) throw error;
    throw new XUnavailable(`${provider}: ${redact(error)}`, { provider, sessionId, cause: null });
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * A user agent that says who we are.
 *
 * Not a browser string. A self-hosted RSSHub does not care, but a provider that
 * one day wants to rate-limit us specifically should be able to, and a crawler
 * that disguises itself has given up the right to complain about how it is
 * treated.
 */
const USER_AGENT = 'RSSAmplifier/1.0 (+https://rssamplifier.com/about)';

/** @param {Response} res */
async function readCapped(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, MAX_BYTES);

  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    if (total >= MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }

  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * An error message with nothing sensitive in it.
 *
 * `fetch` puts the request URL in its own message for most network failures,
 * and a provider URL can carry a session cookie as a query parameter.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function redact(error) {
  const message = String(error?.message ?? error ?? 'failed');
  return message
    .replace(/https?:\/\/\S+/g, (url) => safeUrl(url))
    .replace(/[0-9a-f]{32,}/gi, '<redacted>')
    .slice(0, 200);
}

/**
 * A URL reduced to origin and path — no query, no credentials, no fragment.
 *
 * @param {string} raw
 * @returns {string}
 */
export function safeUrl(raw) {
  try {
    const url = new URL(String(raw));
    return `${url.origin}${url.pathname}`;
  } catch {
    return '<url>';
  }
}
