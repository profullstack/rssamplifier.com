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

export {
  parseInstagramInput,
  instagramRef,
  instagramUrl,
  instagramPath,
  instagramSlug,
  instagramTitle,
  instagramSource,
  instagramSpecFromRef,
  INSTAGRAM_MODES,
} from './src/instagram/canonical.js';
export { fetchInstagramSource } from './src/instagram/fetch.js';

export {
  parseFacebookInput,
  facebookRef,
  facebookUrl,
  facebookPath,
  facebookSlug,
  facebookTitle,
  facebookSource,
  facebookSpecFromRef,
} from './src/facebook/canonical.js';
export { fetchFacebookSource, pageToken, connectedPages } from './src/facebook/fetch.js';

export { failureResult, retryAfterFor, ANOMALY_SECONDS, UNCONFIGURED_SECONDS } from './src/failure.js';
export { fetchSocialSource, isCollected } from './src/collect.js';

export { socialSourceFrom, socialPathFor, SOCIAL_NETWORKS } from './src/identify.js';
export { socialDisplayTitle } from './src/display.js';
