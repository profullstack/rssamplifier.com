import { trends } from '@rssamplifier/db';

import { db } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

const clamp = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * What the directory is writing about more than it was last week.
 *
 * Open, like the rest of the directory. Reads the daily rollup, so it is cheap,
 * and the numbers only change when a day is rolled up, hence the hour of cache.
 * `count` is feeds in a one in four sample of English blogs and news sites, so
 * it is a measure of movement rather than a census.
 */
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const window = clamp(params.get('window'), 1, 14, 7);
  const limit = clamp(params.get('limit'), 1, 200, 50);
  const result = await trends.trendingTerms(db(), { window, limit });
  return Response.json(
    {
      source: 'rssamp',
      window_days: window,
      generated_at: result.generatedAt,
      documents: result.feeds,
      topics: result.topics,
    },
    { headers: { 'cache-control': 'public, max-age=3600' } },
  );
}
