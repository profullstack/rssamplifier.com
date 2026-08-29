/**
 * RSSHub — the primary collector (§11).
 *
 * Self-hosted, alongside the app. That is the whole reason it is first: a
 * public instance of anything in this space is somebody else's rate limit, and
 * the Nitter era ended precisely because a shared instance is the unit that
 * gets blocked. `RSSHUB_BASE_URL` points at a container in the same project and
 * is never exposed publicly (§48).
 *
 * **Sessions are RSSHub's, not ours, unless configured otherwise.** RSSHub
 * takes its X cookies from its own environment and rotates them internally, so
 * by default this provider passes none and the pool in `../sessions.js` simply
 * has nothing to hand it. That is a real limitation and it is stated rather
 * than papered over: with a stock RSSHub, §15's rotation applies to Teapot and
 * to nothing else. Where a deployment *does* expose a per-request parameter for
 * it, `RSSHUB_SESSION_PARAM` names it and the session travels in the query.
 * Nothing here guesses at that parameter's name, because guessing would mean
 * putting a live cookie on a query string an instance might log.
 */

import { providerGet } from './http.js';
import { postsFromRss } from './fromRss.js';
import { XUnavailable } from '../errors.js';

export const NAME = 'rsshub';

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {import('../types.js').XProvider}
 */
export function rsshubProvider(env = process.env) {
  const base = String(env.RSSHUB_BASE_URL ?? '').replace(/\/+$/, '');
  const accessKey = String(env.RSSHUB_ACCESS_KEY ?? '').trim();
  const sessionParam = String(env.RSSHUB_SESSION_PARAM ?? '').trim();
  const timeoutMs = Number(env.X_FETCH_TIMEOUT_MS) || undefined;

  return {
    name: NAME,

    configured: () => Boolean(base),

    async healthCheck(ctx = {}) {
      if (!base) return false;
      try {
        // RSSHub's own liveness route. Deliberately not a Twitter route: a
        // health check that fetches a real timeline spends an X request every
        // time it runs, which §32 warns about, and would report the provider
        // down whenever one *account* is rate limited.
        await providerGet(`${base}/healthz`, {
          provider: NAME,
          timeoutMs: 5000,
          fetch: ctx.fetch,
        });
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
      if (!base) throw new XUnavailable('rsshub: no RSSHUB_BASE_URL', { provider: NAME });

      const url = new URL(base + routeFor(request));
      // RSSHub renders the post itself rather than a stripped summary, keeps
      // the author out of the title (we build our own), and includes reposts —
      // filtering those is our decision, taken in `normalize.js`, so that one
      // stored source can serve both a with-reposts and a without-reposts view
      // without being crawled twice.
      url.searchParams.set('readable', '1');
      url.searchParams.set('showAuthorInTitle', '0');
      url.searchParams.set('showQuotedInTitle', '1');
      url.searchParams.set('includeRts', '1');
      url.searchParams.set('excludeReplies', request.mode === 'replies' ? '0' : '1');
      if (request.limit) url.searchParams.set('limit', String(Math.min(request.limit, 100)));
      if (accessKey) url.searchParams.set('key', accessKey);
      if (sessionParam && ctx.session?.authToken) {
        url.searchParams.set(sessionParam, ctx.session.authToken);
      }

      const { body } = await providerGet(url, {
        provider: NAME,
        sessionId: ctx.session?.id ?? null,
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
 * Which RSSHub route answers which of our modes (§11).
 *
 * `/twitter/user/:id` covers three of the five: replies and the plain timeline
 * differ only by the `excludeReplies` parameter set above, which is why they
 * share a route here and diverge in the query.
 *
 * @param {import('../types.js').XFetchRequest} request
 * @returns {string}
 */
function routeFor(request) {
  switch (request.mode) {
    case 'user':
    case 'replies':
      return `/twitter/user/${encodeURIComponent(request.username)}`;
    case 'media':
      return `/twitter/media/${encodeURIComponent(request.username)}`;
    case 'search':
      // The query is passed through whole (§28). RSSHub hands it to X's own
      // search, so `from:OpenAI lang:en` works and nothing here has to know
      // what those operators mean.
      return `/twitter/keyword/${encodeURIComponent(request.query)}`;
    case 'list':
      return `/twitter/list/${encodeURIComponent(request.listId)}`;
    default:
      throw new XUnavailable(`rsshub: unsupported mode ${request.mode}`, { provider: NAME });
  }
}
