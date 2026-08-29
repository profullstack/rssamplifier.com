/**
 * Queries for social sources — X and Reddit — and for the health tables the X
 * provider stack writes to.
 *
 * Its own module rather than more of `queries.js`, which is already 3,900
 * lines: nothing here is read by the ordinary crawl path, and a caller that
 * imports `social` is announcing what it is about to do.
 *
 * The shape of the deal with `queries.js` is worth stating, because it is what
 * keeps this feature from spreading. A social source is a row in `feeds` like
 * any other, so every query about *what a source published* — items, topics,
 * search, alerts, the river — is already written and is not repeated here. What
 * is here is only the part that is genuinely new: finding a row by its
 * canonical ref, creating one, and listing a network.
 */

import { newId, nowIso } from './client.js';

/**
 * @typedef {import('@libsql/client').Client} Client
 */

/** The interval a source starts on when its caller names none. */
const DEFAULT_START_MINUTES = 60;

/**
 * The one source behind a canonical ref.
 *
 * This is what `/r/programming` and `/x/OpenAI` resolve through, and it is the
 * query that makes §39 true: ten thousand subscribers to `@OpenAI` are ten
 * thousand calls to *this*, all landing on one row, and none of them reach X.
 *
 * @param {Client} db
 * @param {string} ref
 * @returns {Promise<object|null>}
 */
export async function feedBySocialRef(db, ref) {
  const key = String(ref ?? '');
  if (!key) return null;

  const result = await db.execute({
    sql: 'select * from feeds where social_ref = ? limit 1',
    args: [key],
  });

  return result.rows[0] ?? null;
}

/**
 * Every source on one network, newest first.
 *
 * @param {Client} db
 * @param {string} network
 * @param {{ limit?: number, offset?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listSocialFeeds(db, network, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200));
  const offset = Math.max(0, Number(opts.offset) || 0);

  const result = await db.execute({
    sql: `select id, slug, title, description, social_ref, social_network, site_url, image_url,
                 item_count, status, last_success_at, last_published_at, created_at
            from feeds
           where social_network = ?
        order by item_count desc, created_at desc
           limit ? offset ?`,
    args: [String(network), limit, offset],
  });

  return result.rows;
}

/**
 * How many sources one network has, and how many of them have ever been read.
 *
 * Two numbers rather than one because they are very far apart here: the
 * subreddit import put 50,099 rows in and the crawler has read a fraction of
 * them, so a bare count on `/r` would promise a directory that is mostly
 * unread. See the `freshness` note in the MCP server's instructions for the
 * same distinction made to agents.
 *
 * @param {Client} db
 * @param {string} network
 * @returns {Promise<{ total: number, crawled: number }>}
 */
export async function countSocialFeeds(db, network) {
  const result = await db.execute({
    sql: `select count(*) as total,
                 sum(case when last_success_at is not null then 1 else 0 end) as crawled
            from feeds where social_network = ?`,
    args: [String(network)],
  });

  const row = result.rows[0] ?? {};
  return { total: Number(row.total ?? 0), crawled: Number(row.crawled ?? 0) };
}

/**
 * Create a social source, or hand back the one that is already there.
 *
 * The whole of §37/§38 lives in the `on conflict do nothing` and the read after
 * it. Two people submitting `@OpenAI` a second apart must not create two rows,
 * and the race is not hypothetical — the submit path is public and unauthenticated.
 * The unique index on `social_ref` is the arbiter; this function just declines
 * to argue with it.
 *
 * Inserted as `pending`, like every other new feed: the crawler picks it up on
 * its next tick and the first fetch happens on the poller, never on the web
 * request that created it (§17). The submitter is shown a page that fills in.
 *
 * @param {Client} db
 * @param {{
 *   network: string, ref: string, slug: string, title: string, feedUrl: string,
 *   siteUrl?: string|null, config?: object|null, priority?: number,
 *   intervalMinutes?: number,
 * }} source `intervalMinutes` is the platform's floor, supplied by the caller —
 *   this package deliberately does not import @rssamplifier/social to look it
 *   up, because the dependency would run the wrong way: social already reads
 *   nothing from db, and db has no other reason to know what a platform is.
 * @returns {Promise<{ id: string, slug: string, created: boolean }>}
 */
export async function upsertSocialSource(db, source) {
  const existing = await feedBySocialRef(db, source.ref);
  if (existing) {
    return { id: String(existing.id), slug: String(existing.slug), created: false };
  }

  const id = newId();
  const now = nowIso();

  await db.execute({
    sql: `insert into feeds
            (id, slug, feed_url, site_url, title, description, categories, category, status,
             error_count, fetch_interval_minutes, next_fetch_at, item_count,
             created_at, updated_at, source_kind,
             social_network, social_ref, social_config, priority)
          values (?, ?, ?, ?, ?, null, '[]', 'blog', 'pending',
                  0, ?, ?, 0, ?, ?, 'feed', ?, ?, ?, ?)
          on conflict do nothing`,
    args: [
      id,
      source.slug,
      source.feedUrl,
      source.siteUrl ?? null,
      source.title,
      // Provider-collected sources start faster than the 60-minute default,
      // because a timeline is the one thing in this directory where an hour old
      // is visibly stale. §17's "active source: 5 minutes" is the starting
      // point, not the resting one: the crawler's interval learning backs a
      // quiet Page or account off on its own, which is why a rarely-posting
      // Facebook Page costs nothing to start fast.
      //
      // Reddit is excluded deliberately — it is a real feed on somebody else's
      // server, and 50,026 of them at five minutes is how you get rate-limited
      // off a platform. See markHostThrottled in queries.js.
      Math.max(1, Number(source.intervalMinutes) || DEFAULT_START_MINUTES),
      now,
      now,
      now,
      source.network,
      source.ref,
      source.config ? JSON.stringify(source.config) : null,
      source.priority ?? 1,
    ],
  });

  // Read back rather than trusting the insert. `do nothing` is silent about
  // whether it did, and the row that is there may be one another request
  // created in the microseconds between the check above and this insert.
  const row = await feedBySocialRef(db, source.ref);
  if (!row) {
    // The slug collided rather than the ref — a different source already holds
    // this name. The caller retries with a suffixed slug.
    return { id: '', slug: '', created: false };
  }

  return { id: String(row.id), slug: String(row.slug), created: String(row.id) === id };
}

/**
 * Change a source's render toggles (§6.3).
 *
 * @param {Client} db
 * @param {string} id
 * @param {object} config
 */
export async function setSocialConfig(db, id, config) {
  await db.execute({
    sql: 'update feeds set social_config = ?, updated_at = ? where id = ?',
    args: [JSON.stringify(config ?? {}), nowIso(), String(id)],
  });
}

/**
 * Every X source that is due, for the provider status page's "stale" count.
 *
 * Staleness is judged on `last_success_at` — when we last *read* the source —
 * and never on `last_published_at`, because an account that has not posted for
 * a month is quiet, not broken (§33). Confusing the two would light the status
 * board up red for a directory working perfectly.
 *
 * @param {Client} db
 * @param {number} [multiplier] how many refresh intervals late counts as stale
 * @returns {Promise<number>}
 */
export async function countStaleSocialFeeds(db, network, multiplier = 3) {
  const result = await db.execute({
    sql: `select count(*) as stale
            from feeds
           where social_network = ?
             and status <> 'dead'
             and last_success_at is not null
             and julianday('now') - julianday(last_success_at)
                 > (fetch_interval_minutes * ?) / 1440.0`,
    args: [String(network), Number(multiplier) || 3],
  });

  return Number(result.rows[0]?.stale ?? 0);
}

// ---------------------------------------------------------------------------
// Provider and session health.
//
// Both pairs are the `{ load, save }` shape `XRegistry` and `XSessionPool`
// accept, so the runtime is wired with two object literals and neither of those
// classes ever sees a database client. That is what keeps @rssamplifier/social
// testable without one.

/**
 * @param {Client} db
 * @returns {{ load: () => Promise<object[]>, save: (state: object) => Promise<void> }}
 */
export function providerStore(db) {
  return {
    async load() {
      const result = await db.execute('select * from x_provider_state');
      return result.rows;
    },

    async save(state) {
      await db.execute({
        sql: `insert into x_provider_state
                (provider, status, last_success_at, last_failure_at,
                 consecutive_failures, cooldown_until, error_message)
              values (?, ?, ?, ?, ?, ?, ?)
              on conflict (provider) do update set
                status = excluded.status,
                last_success_at = excluded.last_success_at,
                last_failure_at = excluded.last_failure_at,
                consecutive_failures = excluded.consecutive_failures,
                cooldown_until = excluded.cooldown_until,
                error_message = excluded.error_message`,
        args: [
          String(state.provider),
          String(state.status ?? 'unknown'),
          state.last_success_at ?? null,
          state.last_failure_at ?? null,
          Number(state.consecutive_failures ?? 0),
          state.cooldown_until ?? null,
          state.error_message ? String(state.error_message).slice(0, 200) : null,
        ],
      });
    },
  };
}

/**
 * @param {Client} db
 * @returns {{ load: () => Promise<object[]>, save: (state: object) => Promise<void> }}
 */
export function sessionStore(db) {
  return {
    async load() {
      const result = await db.execute('select * from x_sessions');
      return result.rows;
    },

    async save(state) {
      await db.execute({
        sql: `insert into x_sessions
                (id, status, cooldown_until, last_used_at, consecutive_failures, last_error)
              values (?, ?, ?, ?, ?, ?)
              on conflict (id) do update set
                status = excluded.status,
                cooldown_until = excluded.cooldown_until,
                last_used_at = excluded.last_used_at,
                consecutive_failures = excluded.consecutive_failures,
                last_error = excluded.last_error`,
        args: [
          String(state.id),
          String(state.status ?? 'healthy'),
          state.cooldown_until ?? null,
          state.last_used_at ?? null,
          Number(state.consecutive_failures ?? 0),
          // Truncated here as well as at the writer, because this column is
          // rendered on a status page and a 4KB provider stack trace on it is
          // both useless and a way to leak a URL. Never a token: see redact().
          state.last_error ? String(state.last_error).slice(0, 200) : null,
        ],
      });
    },
  };
}

/**
 * Provider health as the status page wants it, without the registry.
 *
 * The web app has no X runtime of its own — it never collects anything — so it
 * reads the table the poller writes. That is also why the page can be honest
 * about being a lagging view rather than a live probe.
 *
 * @param {Client} db
 * @returns {Promise<object[]>}
 */
export async function providerStates(db) {
  const result = await db.execute('select * from x_provider_state order by provider');
  return result.rows;
}

/**
 * @param {Client} db
 * @returns {Promise<object[]>}
 */
export async function sessionStates(db) {
  const result = await db.execute(
    'select id, status, cooldown_until, last_used_at, consecutive_failures, last_error from x_sessions order by id',
  );
  return result.rows;
}
