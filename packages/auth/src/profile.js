import { createProfileStore } from '@profullstack/profile';

/**
 * The signup profile (email, names, company domain, job title, LinkedIn), kept
 * by @profullstack/profile in its own `user_profiles` table, keyed by users.id.
 *
 * The client is the libSQL-shaped Postgres pool from @rssamplifier/db, which
 * the package would otherwise take for SQLite because it has `execute`, so the
 * dialect is named. One store per client.
 */

/** @type {WeakMap<object, import('@profullstack/profile').ProfileStore>} */
const stores = new WeakMap();

/**
 * @param {import('@rssamplifier/db/src/pg.js').PgClient} db
 * @returns {import('@profullstack/profile').ProfileStore}
 */
export function profileStore(db) {
  let store = stores.get(db);
  if (!store) {
    store = createProfileStore(db, { dialect: 'postgres' });
    stores.set(db, store);
  }
  return store;
}
