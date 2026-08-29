/**
 * The official X API — the paid, reliable, structured one (§13).
 *
 * Third in priority and first in quality. It is the only provider that returns
 * posts as *data* rather than as somebody's rendering of them, so it is the
 * only one that can tell a reply from a repost from a quote without reading
 * prose, and the only one whose media survives with dimensions attached.
 *
 * It is also the only one that costs money per request, which is why this file
 * carries a budget and the other two do not. The meter is in front of the
 * request rather than behind it: a spend limit that is checked after the call
 * is an accounting record, not a limit.
 *
 * **The budget resets when the process does, unless a store is handed in.**
 * That is stated here rather than discovered later: an in-memory meter on a
 * service that redeploys ten times in a day is not a daily cap. `meter` is the
 * hook for backing it with a table, and a deployment that actually enables this
 * provider should use it.
 */

import { providerGet } from './http.js';
import { XNoSuchSource, XUnavailable, XRateLimited } from '../errors.js';

export const NAME = 'official';

const API = 'https://api.x.com/2';

/** Everything a post needs to normalise without a second request. */
const TWEET_FIELDS = 'created_at,text,referenced_tweets,attachments,public_metrics,author_id';
const EXPANSIONS =
  'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id';
const MEDIA_FIELDS = 'type,url,preview_image_url,width,height';
const USER_FIELDS = 'username,name,profile_image_url';

/**
 * @param {Record<string, string|undefined>} [env]
 * @param {{ meter?: XBudget }} [opts]
 * @returns {import('../types.js').XProvider}
 */
export function officialProvider(env = process.env, opts = {}) {
  const token = String(env.X_API_BEARER_TOKEN ?? '').trim();
  const timeoutMs = Number(env.X_FETCH_TIMEOUT_MS) || undefined;

  const budget =
    opts.meter ??
    new XBudget({
      dailyReadBudget: numberOr(env.X_API_DAILY_READS, 0),
      monthlyReadBudget: numberOr(env.X_API_MONTHLY_READS, 0),
      maxRequestsPerMinute: numberOr(env.X_API_MAX_RPM, 0),
    });

  /** Handle → numeric id, which every timeline call needs and which never changes. */
  const userIds = new Map();

  return {
    name: NAME,

    configured: () => Boolean(token),

    async healthCheck() {
      // No request. The official API's health is X's health, and spending a
      // billed call to confirm it every few minutes is the one health check
      // that could plausibly cost more than the outage it detects.
      return Boolean(token) && budget.available();
    },

    /**
     * @param {import('../types.js').XFetchRequest} request
     * @param {import('../types.js').XProviderContext} ctx
     */
    async fetch(request, ctx = {}) {
      if (!token) throw new XUnavailable('official: no X_API_BEARER_TOKEN', { provider: NAME });
      if (!budget.available()) {
        // A budget stop is a rate limit, not an outage: it means come back
        // later, and it must not count against the source's health or trip the
        // provider's failure counter into a cooldown of its own.
        throw new XRateLimited('official: budget exhausted', {
          provider: NAME,
          retryAfter: budget.secondsUntilReset(),
        });
      }

      const get = async (path, params) => {
        budget.spend();
        const url = new URL(API + path);
        for (const [key, value] of Object.entries(params ?? {})) {
          if (value != null && value !== '') url.searchParams.set(key, String(value));
        }
        const { body } = await providerGet(url, {
          provider: NAME,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          timeoutMs,
          fetch: ctx.fetch,
          signal: ctx.signal,
        });
        return JSON.parse(body);
      };

      const payload = await route(request, get, userIds);
      return shape(payload, request);
    },
  };
}

/**
 * One request per mode, except a user timeline, which needs the account's
 * numeric id first. That lookup is cached for the life of the process: a
 * handle's id is permanent, and paying for it on every crawl of every account
 * would roughly double this provider's bill for a fact that never changes.
 */
async function route(request, get, userIds) {
  switch (request.mode) {
    case 'user':
    case 'replies':
    case 'media': {
      const id = await userId(request.username, get, userIds);
      return get(`/users/${id}/tweets`, {
        max_results: clamp(request.limit ?? 50),
        pagination_token: request.cursor,
        // Replies are asked for only where they are the point (§25). Reposts
        // always come, because whether to show them is our reader's setting and
        // not something to re-crawl for.
        exclude: request.mode === 'replies' ? undefined : 'replies',
        'tweet.fields': TWEET_FIELDS,
        expansions: EXPANSIONS,
        'media.fields': MEDIA_FIELDS,
        'user.fields': USER_FIELDS,
      });
    }

    case 'search':
      return get('/tweets/search/recent', {
        query: request.query,
        max_results: clamp(request.limit ?? 50),
        next_token: request.cursor,
        'tweet.fields': TWEET_FIELDS,
        expansions: EXPANSIONS,
        'media.fields': MEDIA_FIELDS,
        'user.fields': USER_FIELDS,
      });

    case 'list':
      return get(`/lists/${encodeURIComponent(request.listId)}/tweets`, {
        max_results: clamp(request.limit ?? 50),
        pagination_token: request.cursor,
        'tweet.fields': TWEET_FIELDS,
        expansions: EXPANSIONS,
        'media.fields': MEDIA_FIELDS,
        'user.fields': USER_FIELDS,
      });

    default:
      throw new XUnavailable(`official: unsupported mode ${request.mode}`, { provider: NAME });
  }
}

async function userId(username, get, cache) {
  const key = String(username).toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const payload = await get(`/users/by/username/${encodeURIComponent(username)}`, {
    'user.fields': USER_FIELDS,
  });

  const id = payload?.data?.id;
  if (!id) throw new XNoSuchSource(`official: no such account @${username}`, { provider: NAME });

  cache.set(key, id);
  return id;
}

/**
 * X's payload as our posts.
 *
 * The API sends a flat `data` array plus an `includes` bag, and every
 * relationship in the response is a key into that bag — so the first thing to
 * do is index it, and the rest is lookups.
 *
 * @param {any} payload
 * @param {import('../types.js').XFetchRequest} request
 * @returns {import('../types.js').XFetchResult}
 */
function shape(payload, request) {
  const users = new Map((payload?.includes?.users ?? []).map((user) => [user.id, user]));
  const media = new Map((payload?.includes?.media ?? []).map((entry) => [entry.media_key, entry]));
  const referenced = new Map((payload?.includes?.tweets ?? []).map((tweet) => [tweet.id, tweet]));

  const toPost = (tweet) => {
    if (!tweet?.id) return null;

    const author = users.get(tweet.author_id);
    const refs = tweet.referenced_tweets ?? [];
    const repostRef = refs.find((ref) => ref.type === 'retweeted');
    const quoteRef = refs.find((ref) => ref.type === 'quoted');
    const replyRef = refs.find((ref) => ref.type === 'replied_to');

    return {
      id: String(tweet.id),
      url: author
        ? `https://x.com/${author.username}/status/${tweet.id}`
        : `https://x.com/i/status/${tweet.id}`,
      text: String(tweet.text ?? ''),
      createdAt: tweet.created_at ?? null,
      author: {
        id: tweet.author_id,
        username: author?.username ?? request.username ?? 'unknown',
        displayName: author?.name,
        avatarUrl: author?.profile_image_url,
      },
      replyToId: replyRef?.id ?? null,
      quotedPostId: quoteRef?.id ?? null,
      repostOfId: repostRef?.id ?? null,
      // Nested where the bag has it. When it does not — the API omits a
      // referenced tweet whose author has since protected or deleted it — the
      // id stays and the nested post is null, which `normalizeXPost` handles by
      // rendering the post's own text.
      repostOf: repostRef ? toPost(referenced.get(repostRef.id)) : null,
      quotedPost: quoteRef ? toPost(referenced.get(quoteRef.id)) : null,
      media: (tweet.attachments?.media_keys ?? [])
        .map((key) => media.get(key))
        .filter(Boolean)
        .map((entry) => ({
          type: entry.type === 'animated_gif' ? 'gif' : entry.type === 'video' ? 'video' : 'image',
          url: entry.url ?? entry.preview_image_url,
          previewUrl: entry.preview_image_url ?? entry.url,
          width: entry.width,
          height: entry.height,
        }))
        .filter((entry) => entry.url),
      metrics: tweet.public_metrics
        ? {
            replies: tweet.public_metrics.reply_count,
            reposts: tweet.public_metrics.retweet_count,
            likes: tweet.public_metrics.like_count,
            views: tweet.public_metrics.impression_count,
          }
        : undefined,
    };
  };

  let posts = (payload?.data ?? []).map(toPost).filter(Boolean);

  // There is no media-only timeline endpoint. Filtering here is honest about
  // what that costs: the request was billed for the whole timeline and most of
  // it is thrown away, so a media feed on the official provider is the most
  // expensive thing this file can do. `from:user has:media` through search is
  // the cheaper shape where a deployment's access level allows it.
  if (request.mode === 'media') {
    posts = posts.filter((post) => (post.repostOf ?? post).media?.length);
  }

  const self = posts.find((post) => post.author?.username);

  return {
    posts,
    nextCursor: payload?.meta?.next_token ?? undefined,
    displayName: self?.author?.displayName ?? null,
    avatarUrl: self?.author?.avatarUrl ?? null,
  };
}

/**
 * Spend control for a billed provider (§13).
 *
 * Three limits, because they answer three different worries: a burst (rpm), a
 * runaway day, and a month that quietly drifts over budget without any single
 * day looking wrong.
 */
export class XBudget {
  /**
   * @param {{
   *   dailyReadBudget?: number, monthlyReadBudget?: number, maxRequestsPerMinute?: number,
   *   now?: () => number,
   * }} [limits]
   */
  constructor(limits = {}) {
    this.daily = limits.dailyReadBudget ?? 0;
    this.monthly = limits.monthlyReadBudget ?? 0;
    this.rpm = limits.maxRequestsPerMinute ?? 0;
    this.now = limits.now ?? (() => Date.now());
    this.counts = { minute: 0, day: 0, month: 0 };
    this.window = { minute: this.minuteKey(), day: this.dayKey(), month: this.monthKey() };
  }

  minuteKey() {
    return Math.floor(this.now() / 60_000);
  }

  dayKey() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  monthKey() {
    return new Date(this.now()).toISOString().slice(0, 7);
  }

  roll() {
    if (this.window.minute !== this.minuteKey()) {
      this.window.minute = this.minuteKey();
      this.counts.minute = 0;
    }
    if (this.window.day !== this.dayKey()) {
      this.window.day = this.dayKey();
      this.counts.day = 0;
    }
    if (this.window.month !== this.monthKey()) {
      this.window.month = this.monthKey();
      this.counts.month = 0;
    }
  }

  /** Is there room for one more request? A limit of 0 means unlimited. */
  available() {
    this.roll();
    if (this.rpm && this.counts.minute >= this.rpm) return false;
    if (this.daily && this.counts.day >= this.daily) return false;
    if (this.monthly && this.counts.month >= this.monthly) return false;
    return true;
  }

  spend(n = 1) {
    this.roll();
    this.counts.minute += n;
    this.counts.day += n;
    this.counts.month += n;
  }

  /** How long until the tightest exhausted window opens again. */
  secondsUntilReset() {
    this.roll();
    if (this.rpm && this.counts.minute >= this.rpm) {
      return 60 - Math.floor((this.now() % 60_000) / 1000);
    }
    const midnight = Date.UTC(
      new Date(this.now()).getUTCFullYear(),
      new Date(this.now()).getUTCMonth(),
      new Date(this.now()).getUTCDate() + 1,
    );
    return Math.max(60, Math.round((midnight - this.now()) / 1000));
  }

  /** Safe to render on a status page. */
  describe() {
    this.roll();
    return {
      minute: { used: this.counts.minute, limit: this.rpm || null },
      day: { used: this.counts.day, limit: this.daily || null },
      month: { used: this.counts.month, limit: this.monthly || null },
    };
  }
}

function clamp(limit) {
  return Math.max(5, Math.min(Number(limit) || 50, 100));
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
