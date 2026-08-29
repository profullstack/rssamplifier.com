/**
 * The pool of X logins the unofficial providers borrow (§14, §15).
 *
 * **Credentials come from the environment and never from a table.** `auth_token`
 * and `ct0` are a full login to an X account: anyone holding them can post as
 * it, read its messages and change its password. A stolen row from an
 * application database is a much likelier event than a stolen environment, and
 * a database is also what gets copied into a staging dump. So the secrets live
 * in `X_SESSIONS` and the table holds only *state* — which session is in
 * cooldown and why (§36, AC-7).
 *
 * The health state is separated the same way in memory: `credentials` never
 * leave this module, and every other part of the system deals in a session id.
 * `describe()` is the shape a status page may render, and it is a different
 * object from the one `pick()` returns for exactly that reason.
 *
 * **Rotation is least-recently-used among the healthy.** Not round-robin, which
 * is the same thing until a session goes into cooldown and then quietly
 * concentrates load on whichever survivor sits next in the ring; and not
 * random, which cannot promise a session a rest. LRU means a pool of four
 * accounts spreads a rate limit across four rather than discovering it four
 * times in a row on one.
 */

/** Session states, widest to narrowest (§15). */
export const SESSION_STATES = Object.freeze([
  'healthy',
  'cooldown',
  'rate_limited',
  'challenge',
  'expired',
  'disabled',
]);

/** How long a rate-limited session sits out when the server named no interval. */
const DEFAULT_COOLDOWN_SECONDS = 900;

/**
 * Read the pool out of the environment.
 *
 * Two spellings are accepted. The structured one is the one to use:
 *
 *   X_SESSIONS=[{"id":"x-1","authToken":"…","ct0":"…"}]
 *
 * The parallel comma-separated pair from §47 also works, because it is what
 * somebody reading the PRD will reach for first:
 *
 *   X_AUTH_TOKENS=a,b   X_CT0_TOKENS=c,d
 *
 * The PRD itself flags that second form as a long-term mistake and it is worth
 * saying why concretely: the two lists are positional, so deleting one dead
 * account from the middle of `X_AUTH_TOKENS` and forgetting the matching entry
 * in `X_CT0_TOKENS` silently pairs every later token with the wrong cookie. The
 * result is a pool of sessions that all authenticate as nobody. The structured
 * form cannot express that state.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Array<{ id: string, authToken: string, ct0: string }>}
 */
export function sessionsFromEnv(env = process.env) {
  const structured = String(env.X_SESSIONS ?? '').trim();
  if (structured) {
    try {
      const parsed = JSON.parse(structured);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry, index) => ({
            id: String(entry?.id ?? `x-session-${String(index + 1).padStart(3, '0')}`),
            authToken: String(entry?.authToken ?? entry?.auth_token ?? ''),
            ct0: String(entry?.ct0 ?? ''),
          }))
          .filter((entry) => entry.authToken && entry.ct0);
      }
    } catch {
      // A malformed X_SESSIONS falls through to the pair below rather than
      // throwing on boot. A poller that will not start is a worse outcome than
      // one that starts with no X sessions and says so on the status page.
    }
  }

  const auth = splitList(env.X_AUTH_TOKENS);
  const ct0 = splitList(env.X_CT0_TOKENS);

  return auth
    .map((authToken, index) => ({
      id: `x-session-${String(index + 1).padStart(3, '0')}`,
      authToken,
      ct0: ct0[index] ?? '',
    }))
    .filter((entry) => entry.authToken && entry.ct0);
}

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * A pool of sessions with health, cooldown and LRU rotation.
 *
 * `store` is optional and is how state survives a restart: the ingest layer
 * hands in something backed by `x_sessions`. Without one the pool is
 * in-memory, which is correct for tests and for a single short-lived process.
 */
export class XSessionPool {
  /**
   * @param {Array<{ id: string, authToken: string, ct0: string }>} credentials
   * @param {{
   *   store?: { load: () => Promise<object[]>, save: (state: object) => Promise<void> },
   *   now?: () => number,
   *   cooldownSeconds?: number,
   * }} [opts]
   */
  constructor(credentials = [], opts = {}) {
    /** @type {Map<string, { id: string, authToken: string, ct0: string }>} */
    this.credentials = new Map(credentials.map((entry) => [entry.id, entry]));

    /** @type {Map<string, { id: string, status: string, cooldownUntil: number|null, lastUsedAt: number|null, failures: number, lastError: string|null }>} */
    this.state = new Map(
      credentials.map((entry) => [
        entry.id,
        {
          id: entry.id,
          status: 'healthy',
          cooldownUntil: null,
          lastUsedAt: null,
          failures: 0,
          lastError: null,
        },
      ]),
    );

    this.store = opts.store ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.cooldownSeconds = opts.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
  }

  /** How many logins exist at all, healthy or not. */
  get size() {
    return this.credentials.size;
  }

  /** Restore persisted cooldowns, so a restart does not un-ban a bad session. */
  async hydrate() {
    if (!this.store) return;

    const rows = await this.store.load();
    for (const row of Array.isArray(rows) ? rows : []) {
      const current = this.state.get(String(row?.id));
      if (!current) continue;

      current.status = SESSION_STATES.includes(row.status) ? row.status : current.status;
      current.cooldownUntil = row.cooldown_until ? Date.parse(row.cooldown_until) : null;
      current.lastUsedAt = row.last_used_at ? Date.parse(row.last_used_at) : null;
      current.failures = Number(row.consecutive_failures ?? 0);
      current.lastError = row.last_error ?? null;
    }
  }

  /**
   * The least-recently-used healthy session, with its credentials attached.
   *
   * A session whose cooldown has run out comes back healthy here rather than by
   * a sweep, because a timer that has to keep running is one more thing that can
   * be forgotten in a process that restarts on every deploy.
   *
   * @returns {import('./types.js').XSession|null}
   */
  pick() {
    const now = this.now();

    /** @type {typeof this.state extends Map<string, infer V> ? V : never | null} */
    let best = null;
    for (const entry of this.state.values()) {
      if (entry.cooldownUntil && entry.cooldownUntil <= now) {
        entry.status = 'healthy';
        entry.cooldownUntil = null;
      }
      if (entry.status !== 'healthy') continue;
      if (!best || (entry.lastUsedAt ?? 0) < (best.lastUsedAt ?? 0)) best = entry;
    }

    if (!best) return null;

    best.lastUsedAt = now;
    const credentials = this.credentials.get(best.id);

    return {
      id: best.id,
      authToken: credentials.authToken,
      ct0: credentials.ct0,
      status: best.status,
      cooldownUntil: null,
      lastUsedAt: new Date(now).toISOString(),
    };
  }

  /** Nothing is wrong with this session; clear whatever we held against it. */
  async markSuccess(id) {
    const entry = this.state.get(String(id));
    if (!entry) return;

    entry.status = 'healthy';
    entry.cooldownUntil = null;
    entry.failures = 0;
    entry.lastError = null;
    await this.persist(entry);
  }

  /**
   * Something went wrong while this session was in hand. What that means for
   * the session depends entirely on which of the four errors it was — see
   * errors.js — and this method is where that translation lives.
   *
   * @param {string} id
   * @param {Error} error
   */
  async markFailure(id, error) {
    const entry = this.state.get(String(id));
    if (!entry) return;

    entry.failures += 1;
    // The message only. `error.cause` can carry a response object, and a
    // response object carries the request headers, and the request headers
    // carry the cookie this whole module exists to keep out of the database.
    entry.lastError = String(error?.message ?? 'error').slice(0, 200);

    const name = error?.name;

    if (name === 'XRateLimited') {
      entry.status = 'rate_limited';
      const seconds = Number(error.retryAfter) > 0 ? Number(error.retryAfter) : this.cooldownSeconds;
      entry.cooldownUntil = this.now() + seconds * 1000;
    } else if (name === 'XAuthFailed') {
      // Not a cooldown. A cookie that has been invalidated does not become
      // valid again after fifteen minutes, and a session that keeps coming back
      // to fail is a session that keeps burning a request and an attempt.
      // An administrator re-enables it after replacing the credentials.
      entry.status = 'expired';
      entry.cooldownUntil = null;
    } else if (name === 'XNoSuchSource') {
      // The source was wrong, not the session. Nothing is held against it —
      // and note this leaves `failures` incremented above, so it is decremented
      // back here rather than never counted, keeping the branch obvious.
      entry.failures -= 1;
      entry.lastError = null;
    } else {
      // A provider outage, a timeout, a network blip. Short cooldown, so a
      // flaky minute does not empty the pool.
      entry.status = 'cooldown';
      entry.cooldownUntil = this.now() + Math.min(entry.failures, 5) * 60_000;
    }

    await this.persist(entry);
  }

  /** Take a session out of rotation by hand. */
  async disable(id) {
    const entry = this.state.get(String(id));
    if (!entry) return;
    entry.status = 'disabled';
    entry.cooldownUntil = null;
    await this.persist(entry);
  }

  /** Put one back, after its credentials were replaced. */
  async enable(id) {
    const entry = this.state.get(String(id));
    if (!entry) return;
    entry.status = 'healthy';
    entry.cooldownUntil = null;
    entry.failures = 0;
    await this.persist(entry);
  }

  /**
   * The pool as something safe to render.
   *
   * No token, no cookie, not even a length — a status page that reports "32
   * characters" has told an attacker which of two formats they are looking at.
   *
   * @returns {Array<{ id: string, status: string, cooldownUntil: string|null, lastUsedAt: string|null, failures: number, lastError: string|null }>}
   */
  describe() {
    const now = this.now();
    return [...this.state.values()].map((entry) => ({
      id: entry.id,
      status: entry.cooldownUntil && entry.cooldownUntil <= now ? 'healthy' : entry.status,
      cooldownUntil: entry.cooldownUntil ? new Date(entry.cooldownUntil).toISOString() : null,
      lastUsedAt: entry.lastUsedAt ? new Date(entry.lastUsedAt).toISOString() : null,
      failures: entry.failures,
      lastError: entry.lastError,
    }));
  }

  /** @param {{ id: string }} entry */
  async persist(entry) {
    if (!this.store) return;
    await this.store.save({
      id: entry.id,
      status: entry.status,
      cooldown_until: entry.cooldownUntil ? new Date(entry.cooldownUntil).toISOString() : null,
      last_used_at: entry.lastUsedAt ? new Date(entry.lastUsedAt).toISOString() : null,
      consecutive_failures: entry.failures,
      last_error: entry.lastError,
    });
  }
}
