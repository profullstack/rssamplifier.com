/**
 * Social sources: X/Twitter, which publishes no feeds, and Reddit, which does.
 *
 * The two are in one package because they answer the same question — "what is
 * the canonical identity of a thing on a platform, and where does it live on
 * this site?" — and differ only in how much work the answer takes. Reddit needs
 * a URL rewritten; X needs three providers, a session pool and a normaliser.
 */

export {
  X_MODES,
  parseXInput,
  xRef,
  xUrl,
  xPath,
  xSlug,
  xTitle,
  xSource,
  xSpecFromRef,
} from './src/x/canonical.js';

export { normalizeXFeed, normalizeXPost } from './src/x/normalize.js';

export {
  XError,
  XRateLimited,
  XAuthFailed,
  XUnavailable,
  XNoSuchSource,
  classifyResponse,
  retryAfterSeconds,
} from './src/x/errors.js';

export { XSessionPool, sessionsFromEnv, SESSION_STATES } from './src/x/sessions.js';
export { XRegistry } from './src/x/registry.js';
export { XBudget } from './src/x/providers/official.js';
export { rsshubProvider } from './src/x/providers/rsshub.js';
export { teapotProvider } from './src/x/providers/teapot.js';
export { officialProvider } from './src/x/providers/official.js';
export { postsFromRss } from './src/x/providers/fromRss.js';

export { createXRuntime, fetchXSource, xEnabled, readConfig } from './src/x/fetch.js';

export {
  parseRedditInput,
  redditRef,
  redditFeedUrl,
  redditSiteUrl,
  redditPath,
  redditSlug,
  redditTitle,
  redditSource,
  redditSpecFromRef,
} from './src/reddit/canonical.js';

export { socialSourceFrom, socialPathFor, SOCIAL_NETWORKS } from './src/identify.js';
