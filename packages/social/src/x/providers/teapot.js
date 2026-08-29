/**
 * Teapot — the fallback collector (§12).
 *
 * Nitter's URL shape, which is the closest thing this corner of the web has to
 * a convention: `/:username/rss`, `/:username/with_replies/rss`, `/search/rss`.
 * Keeping to it means a deployment can point `TEAPOT_BASE_URL` at Teapot, at a
 * private Nitter, or at anything else speaking the same paths, and this file
 * does not change.
 *
 * **No public RSSAmplifier route may depend on any of that** (§12), which is
 * the reason the whole provider layer exists. The test for whether that has
 * been honoured is simple and worth repeating: search this package for the
 * string `teapot` outside `providers/`, and there should be nothing but the
 * registry entry and the status page's label.
 *
 * The session note from `rsshub.js` applies here too, with the same honesty:
 * a Nitter-shaped bridge keeps its own logged-in accounts, so `TEAPOT_SESSION_HEADER`
 * exists for deployments that accept one per request and is unset by default.
 */

import { providerGet } from './http.js';
import { postsFromRss } from './fromRss.js';
import { XUnavailable } from '../errors.js';

export const NAME = 'teapot';

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {import('../types.js').XProvider}
 */
export function teapotProvider(env = process.env) {
  const base = String(env.TEAPOT_BASE_URL ?? '').replace(/\/+$/, '');
  const sessionHeader = String(env.TEAPOT_SESSION_HEADER ?? '').trim();
  const timeoutMs = Number(env.X_FETCH_TIMEOUT_MS) || undefined;

  return {
    name: NAME,

    configured: () => Boolean(base),

    async healthCheck(ctx = {}) {
      if (!base) return false;
      try {
        // The instance's own front page. Same reasoning as RSSHub's `/healthz`:
        // a health check must not cost an X request (§32).
        await providerGet(`${base}/`, { provider: NAME, timeoutMs: 5000, fetch: ctx.fetch });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * @param {import('../types.js').XFetchRequest} request
     * @param {import('../types.js').XProviderContext} ctx
     */
    async fetch(request, ctx = {}) {
      if (!base) throw new XUnavailable('teapot: no TEAPOT_BASE_URL', { provider: NAME });

      const url = new URL(base + pathFor(request));
      if (request.mode === 'search') {
        url.searchParams.set('f', 'tweets');
        url.searchParams.set('q', request.query);
      }

      const headers = {};
      if (sessionHeader && ctx.session?.authToken) {
        // Header rather than query string, unlike RSSHub's parameter: a header
        // is not in the access log of every proxy between here and there.
        headers[sessionHeader] = ctx.session.authToken;
      }

      const { body } = await providerGet(url, {
        provider: NAME,
        sessionId: ctx.session?.id ?? null,
        headers,
        timeoutMs,
        fetch: ctx.fetch,
        signal: ctx.signal,
      });

      return postsFromRss(body, {
        provider: NAME,
        url: String(url),
        fallbackHandle: request.username,
      });
    },
  };
}

/**
 * @param {import('../types.js').XFetchRequest} request
 * @returns {string}
 */
function pathFor(request) {
  switch (request.mode) {
    case 'user':
      return `/${encodeURIComponent(request.username)}/rss`;
    case 'replies':
      return `/${encodeURIComponent(request.username)}/with_replies/rss`;
    case 'media':
      return `/${encodeURIComponent(request.username)}/media/rss`;
    case 'search':
      return '/search/rss';
    case 'list':
      return `/i/lists/${encodeURIComponent(request.listId)}/rss`;
    default:
      throw new XUnavailable(`teapot: unsupported mode ${request.mode}`, { provider: NAME });
  }
}
