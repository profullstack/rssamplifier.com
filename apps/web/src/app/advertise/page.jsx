import { CATEGORIES } from '../../lib/categories.js';
import { categoryStats } from '../../lib/crawlstats.js';
import Toolbar from '../Toolbar.jsx';

export const metadata = {
  title: 'Advertise',
  description:
    'What RSS Amplifier reaches, and how to get into the ad rotation. Free to join, no monthly fee, and the creatives are made for you.',
};

// Rendered per request, like every other page here that reads the directory,
// and not for the usual reason. Left alone, Next prerenders this one at build
// time — it has no dynamic params and no cookies — and the build has no
// database. `categoryStats` answers a failed read with zeroes rather than
// throwing, so the page would ship saying the directory holds no feeds at all,
// and would keep saying it until the next deploy. The figures are the entire
// point of an advertising page, so the one thing they must not be is frozen at
// whatever the build machine could see.
//
// It costs nothing: `categoryStats` is cached in the process for five minutes
// and served stale while it refreshes, so the request does no database work of
// its own.
export const dynamic = 'force-dynamic';

/**
 * The rate card, except there is no rate card.
 *
 * Every number on this page comes from `categoryStats`, which is the same
 * cached read the status page uses — five minutes, served stale while it
 * refreshes. That matters more than it sounds: an advertising page is exactly
 * the page a stranger loads, and the honest breakdown of this directory is a
 * six-second scan of `feeds` that must not run once per visitor. Reusing the
 * existing cache means this page costs nothing the site was not already paying.
 *
 * Nothing here is estimated or rounded up. The directory is large and growing
 * and that is the pitch; inventing a traffic figure to go with it would be the
 * fastest way to make the real ones worthless.
 */
export default async function AdvertisePage() {
  const stats = await categoryStats();

  const feeds = Number(stats.total ?? 0);
  const posts = stats.categories.reduce((n, c) => n + Number(c.items ?? 0), 0);
  // Feeds re-read in the last day, rather than feeds added in the last week.
  // "Added" is the number an advertising page reaches for and it is the wrong
  // one here: every feed in this directory was created inside the same few
  // days, so the honest answer to "how many were added this week" is "all of
  // them", which reads as a broken counter and says the place is a week old.
  // How much of it we re-read yesterday is the figure that actually means
  // something to a buyer — it says the inventory is live and maintained.
  const crawledLastDay = stats.categories.reduce((n, c) => n + Number(c.crawledLastDay ?? 0), 0);

  // Biggest first: an advertiser reads this table to find their audience, and
  // the order that helps is by size rather than by our internal vocabulary.
  const rows = [...stats.categories]
    .filter((c) => Number(c.feeds ?? 0) > 0)
    .sort((a, b) => Number(b.feeds ?? 0) - Number(a.feeds ?? 0));

  return (
    <>
      <h1>Advertise</h1>
      <p className="lede">
        RSS Amplifier is an open directory of {fmt(feeds)} independent feeds. Ads here run through{' '}
        <a href="https://crawlproof.com/ads" rel="noopener">
          CrawlProof
        </a>
        , and getting into the rotation is free: no setup fee, no monthly fee, no minimum spend, and
        the creatives are designed for you from a URL.
      </p>

      <h2>What the directory holds</h2>
      <dl className="stats">
        <div>
          <dt>Feeds indexed</dt>
          <dd>{fmt(feeds)}</dd>
        </div>
        <div>
          <dt>Posts indexed</dt>
          <dd>{fmt(posts)}</dd>
        </div>
        <div>
          <dt>Re-read in the last day</dt>
          <dd>{fmt(crawledLastDay)}</dd>
        </div>
      </dl>
      <p>
        Read live from the directory, the same numbers the{' '}
        <a href="/crawlstats">crawler status page</a> reports. Every feed has its own permanent page,
        and each category below is also a listing, a topic index and a syndicated feed of its own.
      </p>

      <h2>Where the audience is</h2>
      <table className="crawl-table category-table">
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col" className="num">
              Feeds
            </th>
            <th scope="col" className="num">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const meta = CATEGORIES[String(c.category)];
            return (
              <tr key={String(c.category)}>
                <th scope="row">
                  {meta ? <a href={meta.path}>{meta.heading}</a> : String(c.category)}
                </th>
                <td className="num">{fmt(c.feeds)}</td>
                <td className="num">{(Number(c.share ?? 0) * 100).toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>How to get in the rotation</h2>
      <ol>
        <li>
          Go to{' '}
          <a href="https://crawlproof.com/ads" rel="noopener">
            crawlproof.com/ads
          </a>{' '}
          and give it your landing-page URL.
        </li>
        <li>
          It reads the page for your brand and hands back a full set of creatives — every format at
          once. Edit the copy, swap the palette, upload your own logo, or ship what you get.
        </li>
        <li>
          Set a daily budget. Your campaign enters the rotation on this site, and on every other site
          running the network.
        </li>
      </ol>
      <p>
        You pay <strong>$0.20 a click and nothing for impressions</strong>, so an ad that nobody acts
        on costs nothing. There is no minimum spend, no monthly fee and no sales call, and a first
        deposit is matched in bonus credit up to $100.
      </p>

      <h2>Where the ads actually go</h2>
      <p>
        One slot serves the whole site and the format varies by position: a native text link that
        reads as a line of the page, a 300×250 partway down a run of posts, and a leaderboard on wide
        screens that becomes a 320×50 on a phone. The syndicated feeds carry an ad too, placed in the
        document itself, because a feed has no page for a script to fill.
      </p>
      <p>
        Deliberately unmonetised, and worth knowing before you buy: <a href="/llms.txt">/llms.txt</a>
        , <a href="/opml">/opml</a>, the <a href="/api/feeds">JSON API</a> and the rest of the
        machine-readable surface carry no ads at all — a clean copy for agents is the whole point of
        this directory. Nor does the framed reader, where the article on screen is somebody else’s.
      </p>

      <h2>Run ads on your own site</h2>
      <p>
        The other half of the same network: add your site at{' '}
        <a href="https://crawlproof.com/ads" rel="noopener">
          crawlproof.com/ads
        </a>
        , paste one tag where the ad should go, and earn per click, paid in crypto to a wallet you
        choose. There is no traffic threshold — a hobby project earns less than a busy one, but it is
        not turned away for being small.
      </p>

      <h2>Something else in mind?</h2>
      <p>
        Sponsorship of a category or a topic index is not something the network does, and if that is
        what you want, <a href="/contact">say hello</a> rather than working around it.
      </p>

      <Toolbar />
    </>
  );
}

/**
 * @param {unknown} n
 * @returns {string}
 */
function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}
