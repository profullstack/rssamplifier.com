/**
 * Which provider answers this request, and what happens when it will not (§10).
 *
 * The rule the whole feature rests on is one line long: **the provider never
 * appears in a public URL** (AC-2). Everything else here is bookkeeping in
 * service of that — a reader subscribed to `/x/OpenAI.rss` must not be able to
 * tell, from anything except our status page, whether the posts arrived through
 * RSSHub, Teapot or a paid API, and must not have to resubscribe when that
 * changes.
 *
 * **Failover is per attempt, and the order is fixed.** Not "cheapest healthy" or
 * "fastest lately": a scoring system picks differently on two adjacent crawls
 * of the same source, which makes an intermittent upstream bug impossible to
 * reproduce. Priority comes from `X_PRIMARY_PROVIDER` and
 * `X_FALLBACK_PROVIDERS`, in that order, and the only thing that removes a
 * provider from the list is being unconfigured or being in cooldown.
 *
 * **A cooldown is about the provider, not the source.** Three consecutive
 * failures put it aside for a few minutes so that a hundred queued X sources do
 * not each rediscover the same outage; a single success clears it. The counters
 * live here, and `state()` is what the status page renders (§32).
 */

import { rsshubProvider } from './providers/rsshub.js';
import { teapotProvider } from './providers/teapot.js';
import { officialProvider } from './providers/official.js';
import { XUnavailable } from './errors.js';

/** Failures in a row before a provider is set aside. */
const FAILURES_BEFORE_COOLDOWN = 3;

/** How long it sits out, per consecutive failure beyond that, capped. */
const COOLDOWN_STEP_MS = 60_000;
const COOLDOWN_MAX_MS = 15 * 60_000;

/** The three implementations, by the name used in env and on the status page. */
const BUILDERS = {
  rsshub: rsshubProvider,
  teapot: teapotProvider,
  official: officialProvider,
};

export class XRegistry {
  /**
   * @param {{
   *   env?: Record<string, string|undefined>,
   *   store?: { load: () => Promise<object[]>, save: (state: object) => Promise<void> },
   *   now?: () => number,
   *   providers?: Record<string, import('./types.js').XProvider>,
   * }} [opts]
   */
  constructor(opts = {}) {
    const env = opts.env ?? process.env;
    this.now = opts.now ?? (() => Date.now());
    this.store = opts.store ?? null;

    const built =
      opts.providers ??
      Object.fromEntries(Object.entries(BUILDERS).map(([name, build]) => [name, build(env)]));

    /** @type {Map<string, import('./types.js').XProvider>} */
    this.providers = new Map(Object.entries(built));

    /** @type {Map<string, { provider: string, status: string, failures: number, cooldownUntil: number|null, lastSuccessAt: number|null, lastFailureAt: number|null, lastError: string|null, disabled: boolean }>} */
    this.state = new Map(
      [...this.providers.keys()].map((name) => [
        name,
        {
          provider: name,
          status: 'unknown',
          failures: 0,
          cooldownUntil: null,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastError: null,
          disabled: false,
        },
      ]),
    );

    this.order = orderFrom(env, this.providers);
  }

  /** Restore cooldowns and counters, so a redeploy does not forget an outage. */
  async hydrate() {
    if (!this.store) return;

    for (const row of (await this.store.load()) ?? []) {
      const entry = this.state.get(String(row?.provider));
      if (!entry) continue;
      entry.status = row.status ?? entry.status;
      entry.failures = Number(row.consecutive_failures ?? 0);
      entry.cooldownUntil = row.cooldown_until ? Date.parse(row.cooldown_until) : null;
      entry.lastSuccessAt = row.last_success_at ? Date.parse(row.last_success_at) : null;
      entry.lastFailureAt = row.last_failure_at ? Date.parse(row.last_failure_at) : null;
      entry.lastError = row.error_message ?? null;
      entry.disabled = row.status === 'disabled';
    }
  }

  /**
   * The providers to try, in order, right now.
   *
   * @returns {import('./types.js').XProvider[]}
   */
  candidates() {
    const now = this.now();

    return this.order
      .map((name) => this.providers.get(name))
      .filter(Boolean)
      .filter((provider) => {
        const entry = this.state.get(provider.name);
        if (entry.disabled) return false;
        if (!provider.configured()) return false;
        if (entry.cooldownUntil && entry.cooldownUntil > now) return false;
        return true;
      });
  }

  /**
   * Fetch through the first provider that will answer.
   *
   * The session is chosen per provider attempt rather than once for the whole
   * call, because a session that a rate limit just retired must not be handed
   * to the fallback as well — that is how one bad minute takes out every
   * provider in sequence (§15, §16).
   *
   * @param {import('./types.js').XFetchRequest} request
   * @param {{
   *   sessions?: import('./sessions.js').XSessionPool,
   *   onEvent?: (event: string, fields: object) => void,
   *   signal?: AbortSignal,
   *   fetch?: typeof fetch,
   * }} [ctx]
   * @returns {Promise<import('./types.js').XFetchResult & { provider: string }>}
   */
  async fetch(request, ctx = {}) {
    const emit = ctx.onEvent ?? (() => {});
    const candidates = this.candidates();

    if (candidates.length === 0) {
      throw new XUnavailable('no X provider is configured and healthy');
    }

    let last = null;

    for (const provider of candidates) {
      const session = ctx.sessions?.pick() ?? null;
      const started = this.now();

      emit('x.fetch.started', { provider: provider.name, sessionId: session?.id ?? null });

      try {
        const result = await provider.fetch(request, {
          session,
          signal: ctx.signal,
          fetch: ctx.fetch,
        });

        await this.markSuccess(provider.name);
        if (session) await ctx.sessions?.markSuccess(session.id);

        emit('x.fetch.success', {
          provider: provider.name,
          sessionId: session?.id ?? null,
          durationMs: this.now() - started,
          itemCount: result.posts?.length ?? 0,
        });

        return { ...result, provider: provider.name };
      } catch (error) {
        last = error;

        if (session) await ctx.sessions?.markFailure(session.id, error);

        // A source that does not exist is not a provider fault, and failing
        // over to ask two more providers about an account that was deleted is
        // three requests to learn one thing. It stops here.
        if (error?.name === 'XNoSuchSource') {
          emit('x.fetch.failed', { provider: provider.name, error: error.message });
          throw error;
        }

        if (error?.name === 'XRateLimited') {
          emit('x.fetch.rate_limited', {
            provider: provider.name,
            sessionId: session?.id ?? null,
            retryAfter: error.retryAfter ?? null,
          });
          // The provider itself is fine — one of its sessions is throttled — so
          // its failure counter is left alone and the next provider is tried.
          continue;
        }

        await this.markFailure(provider.name, error);
        emit('x.fetch.failed', {
          provider: provider.name,
          sessionId: session?.id ?? null,
          error: error?.message ?? 'failed',
        });
        emit('x.provider.failover', { from: provider.name });
      }
    }

    throw last ?? new XUnavailable('every X provider refused');
  }

  async markSuccess(name) {
    const entry = this.state.get(name);
    if (!entry) return;
    entry.status = 'healthy';
    entry.failures = 0;
    entry.cooldownUntil = null;
    entry.lastSuccessAt = this.now();
    entry.lastError = null;
    await this.persist(entry);
  }

  async markFailure(name, error) {
    const entry = this.state.get(name);
    if (!entry) return;

    entry.failures += 1;
    entry.lastFailureAt = this.now();
    entry.lastError = String(error?.message ?? 'failed').slice(0, 200);
    entry.status = 'failing';

    if (entry.failures >= FAILURES_BEFORE_COOLDOWN) {
      const extra = entry.failures - FAILURES_BEFORE_COOLDOWN + 1;
      entry.status = 'cooldown';
      entry.cooldownUntil = this.now() + Math.min(extra * COOLDOWN_STEP_MS, COOLDOWN_MAX_MS);
    }

    await this.persist(entry);
  }

  /** Take a provider out of the rotation entirely — the kill switch of §42. */
  async disable(name) {
    const entry = this.state.get(name);
    if (!entry) return;
    entry.disabled = true;
    entry.status = 'disabled';
    await this.persist(entry);
  }

  async enable(name) {
    const entry = this.state.get(name);
    if (!entry) return;
    entry.disabled = false;
    entry.status = 'unknown';
    entry.failures = 0;
    entry.cooldownUntil = null;
    await this.persist(entry);
  }

  /**
   * Ask each provider whether it is up, without spending an X request.
   *
   * @returns {Promise<Record<string, boolean>>}
   */
  async healthCheck(ctx = {}) {
    const results = await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        if (!provider.configured()) return [provider.name, false];
        try {
          return [provider.name, await provider.healthCheck(ctx)];
        } catch {
          return [provider.name, false];
        }
      }),
    );

    for (const [name, ok] of results) {
      const entry = this.state.get(name);
      if (!entry || entry.disabled) continue;
      if (ok && entry.status === 'unknown') entry.status = 'healthy';
      if (!ok && entry.status === 'healthy') entry.status = 'failing';
    }

    return Object.fromEntries(results);
  }

  /**
   * The table §32 asks for. Nothing here is a secret: provider names, counts
   * and timestamps only.
   */
  describe() {
    const now = this.now();
    return this.order
      .map((name) => this.state.get(name))
      .filter(Boolean)
      .map((entry) => ({
        provider: entry.provider,
        configured: Boolean(this.providers.get(entry.provider)?.configured()),
        status: entry.disabled
          ? 'disabled'
          : entry.cooldownUntil && entry.cooldownUntil > now
            ? 'cooldown'
            : entry.status,
        consecutiveFailures: entry.failures,
        cooldownUntil: entry.cooldownUntil ? new Date(entry.cooldownUntil).toISOString() : null,
        lastSuccessAt: entry.lastSuccessAt ? new Date(entry.lastSuccessAt).toISOString() : null,
        lastFailureAt: entry.lastFailureAt ? new Date(entry.lastFailureAt).toISOString() : null,
        lastError: entry.lastError,
      }));
  }

  async persist(entry) {
    if (!this.store) return;
    await this.store.save({
      provider: entry.provider,
      status: entry.status,
      consecutive_failures: entry.failures,
      cooldown_until: entry.cooldownUntil ? new Date(entry.cooldownUntil).toISOString() : null,
      last_success_at: entry.lastSuccessAt ? new Date(entry.lastSuccessAt).toISOString() : null,
      last_failure_at: entry.lastFailureAt ? new Date(entry.lastFailureAt).toISOString() : null,
      error_message: entry.lastError,
    });
  }
}

/**
 * `X_PRIMARY_PROVIDER` then `X_FALLBACK_PROVIDERS`, deduplicated, with anything
 * unnamed appended so a provider added to the code is reachable before anybody
 * remembers to add it to the environment.
 */
function orderFrom(env, providers) {
  const primary = String(env.X_PRIMARY_PROVIDER ?? 'rsshub').trim();
  const fallbacks = String(env.X_FALLBACK_PROVIDERS ?? 'teapot,official')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  const seen = new Set();
  const order = [];

  for (const name of [primary, ...fallbacks, ...providers.keys()]) {
    if (!name || seen.has(name) || !providers.has(name)) continue;
    seen.add(name);
    order.push(name);
  }

  return order;
}
