import { riverFail } from '../../../../../../lib/river.js';
import { socialRiver, xTarget } from '../../../../../../lib/socialRiver.js';

export const dynamic = 'force-dynamic';

/**
 * An X search. `/x/search.rss?q=bitcoin` rewrites here.
 *
 * The query stays in the query string rather than becoming a path segment, and
 * that is the one design decision in this file. §5 shows a slugged form
 * (`/x/search/artificial-intelligence.rss`) and §28 the query-string one; only
 * the second can carry `from:OpenAI lang:en` without inventing an escaping
 * scheme, and a subscription URL is a bad place to invent one. X's operator
 * syntax is passed through whole and never reimplemented.
 *
 * The `?q=` survives the rewrite because a route handler's `req.url` is the URL
 * the *client* asked for — the same reason `/following.rss?t=` works and a
 * destination query string would not. See the note in next.config.mjs.
 *
 * @param {Request} req
 * @param {{ params: Promise<{ format: string }> }} ctx
 */
export async function GET(req, { params }) {
  const { format } = await params;
  const url = new URL(req.url);
  const query = (url.searchParams.get('q') ?? '').trim();

  if (!query) {
    return riverFail(format, 400, 'no query', 'Ask for /x/search.rss?q=your+search');
  }

  const target = xTarget({ query });
  if (!target) {
    return riverFail(format, 400, `not a usable X search: ${query}`, 'Try a shorter query.');
  }

  return socialRiver({
    ref: target.ref,
    canonical: target.canonical,
    label: target.label,
    query: target.query,
    format,
    limit: url.searchParams.get('limit'),
    req,
  });
}
