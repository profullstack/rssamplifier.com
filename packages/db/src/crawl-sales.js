import { nowIso } from './client.js';

/**
 * The crawler paywall's books.
 *
 * traffic_hourly counts who asked and who was refused. This is the other half:
 * who paid. Kept as one row per sale rather than a rollup, because a sale is
 * rare enough that the write costs nothing, and because the payment reference
 * has to be unique for the deduplication below to mean anything.
 *
 * @typedef {import('@libsql/client').Client} Client
 */

/**
 * Book a sale.
 *
 * `on conflict (ref) do nothing` is the whole reason `ref` is unique: a
 * settlement delivered twice must book once. A pass bought without a
 * reference still records, it just cannot be deduplicated.
 *
 * Nothing here binds `undefined`: the remote libSQL client throws on it while
 * a local file binds it as null, so an undefined slips through every local
 * test and fails only in production.
 *
 * @param {Client} db
 * @param {{ payer?: string|null, ref?: string|null, days?: number, priceCents?: number,
 *           totalCents?: number, currency?: string, userAgent?: string|null,
 *           agent?: string|null, expiresAt?: string|null }} sale
 * @returns {Promise<void>}
 */
export async function recordCrawlSale(db, sale) {
  await db.execute({
    sql: `insert into crawl_sales
            (payer, ref, days, price_cents, total_cents, currency, user_agent, agent, expires_at, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (ref) do nothing`,
    args: [
      sale.payer ?? null,
      sale.ref ?? null,
      Number(sale.days ?? 1),
      Number(sale.priceCents ?? 0),
      Number(sale.totalCents ?? 0),
      String(sale.currency ?? 'USD'),
      sale.userAgent ?? null,
      sale.agent ?? null,
      sale.expiresAt ?? null,
      nowIso(),
    ],
  });
}

/**
 * Every sale since `sinceIso`, oldest first.
 *
 * @param {Client} db
 * @param {string} sinceIso
 */
export async function crawlSalesSince(db, sinceIso) {
  const { rows } = await db.execute({
    sql: `select payer, agent, user_agent, total_cents, days, created_at
          from crawl_sales where created_at >= ? order by created_at`,
    args: [String(sinceIso)],
  });
  return rows;
}
