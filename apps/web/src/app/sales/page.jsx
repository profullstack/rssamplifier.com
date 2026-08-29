import { dataset } from '@rssamplifier/db';

import { categoryStats } from '../../lib/crawlstats.js';
import { corpusFigures } from '../../lib/corpus.js';
import { latestClosedWindow } from '../../lib/datasetWindow.js';
import Toolbar from '../Toolbar.jsx';

export const metadata = {
  title: 'Training data',
  description:
    'License the RSS Amplifier directory as a training corpus: independent blogs, podcasts and video feeds, sliced on a four-hour clock and streamed as gzipped NDJSON.',
};

// Rendered per request, for exactly the reason /advertise is. Left alone, Next
// prerenders a page with no dynamic params at build time, and the build has no
// database — so the figures below would be whatever the build machine could see,
// frozen until the next deploy. On a page whose entire argument is the size and
// freshness of a dataset, stale numbers are worse than none.
export const dynamic = 'force-dynamic';

/**
 * The corpus offer, without a rate card.
 *
 * ## Why there is no price on this page
 *
 * Because there is no price. Corpus licensing is negotiated per buyer — what
 * they may keep after the term, whether they may redistribute it, whether
 * attribution travels with the text — and those terms move the number by more
 * than any volume tier would. A published figure would either be the wrong one
 * for everybody, or a fiction with a "contact us for enterprise" underneath it,
 * which is the same thing with extra steps.
 *
 * So this page does one job: say precisely what the data is, so that somebody
 * can decide whether to start the conversation, and then start it.
 *
 * ## Why it is so specific about what the corpus is *not*
 *
 * Every number here is read live from the directory, and the paragraph about
 * article bodies is the most important one on the page. "4.7 million posts"
 * invites the reading "4.7 million articles of prose", and that is not what this
 * database holds — bodies stopped being stored for every post in
 * `0031_item_body_on_demand.sql`, and full text lives in a smaller table. A buyer
 * who discovers that after signing is a refund and a reputation; a buyer who
 * reads it here is a buyer who wanted the metadata anyway, or who asks us to
 * change what the crawler stores, which is a conversation worth having.
 *
 * The same instinct runs through /advertise ("nothing here is estimated or
 * rounded up") and /terms ("measured numbers are claims about the past that
 * anybody can check"). This page inherits it because it is the page where the
 * temptation to round up is strongest.
 */
export default async function SalesPage({ searchParams }) {
  const params = await searchParams;
  const sent = params?.sent === '1';
  const error = typeof params?.error === 'string' ? params.error : null;

  const [stats, corpus] = await Promise.all([categoryStats(), corpusFigures()]);

  const feeds = Number(stats?.total ?? 0);
  const posts = (stats?.categories ?? []).reduce((n, c) => n + Number(c.items ?? 0), 0);
  const crawledLastDay = (stats?.categories ?? []).reduce(
    (n, c) => n + Number(c.crawledLastDay ?? 0),
    0,
  );

  return (
    <>
      <h1>Training data</h1>
      <p className="lede">
        RSS Amplifier crawls {fmt(feeds)} independent feeds — blogs, podcasts and video channels
        that publish on their own sites rather than inside a platform. The whole directory is
        available as a licensed corpus, sliced on a {dataset.WINDOW_HOURS}-hour clock and streamed
        as gzipped NDJSON, so a training pipeline can pull the new rows every{' '}
        {dataset.WINDOW_HOURS} hours and keep a mirror current indefinitely.
      </p>

      <h2>What is in it</h2>
      <dl className="stats">
        <div>
          <dt>Feeds</dt>
          <dd>{fmt(feeds)}</dd>
        </div>
        <div>
          <dt>Post records</dt>
          <dd>{fmt(posts)}</dd>
        </div>
        {corpus ? (
          <div>
            <dt>Full-text articles</dt>
            <dd>{fmt(corpus.articles)}</dd>
          </div>
        ) : null}
        {corpus ? (
          <div>
            <dt>Authors</dt>
            <dd>{fmt(corpus.authors)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Feeds re-read in the last day</dt>
          <dd>{fmt(crawledLastDay)}</dd>
        </div>
      </dl>
      <p>
        Read live from the directory as this page loaded — the same numbers the{' '}
        <a href="/crawlstats">crawler status page</a> reports, from the same cache. Nothing on this
        page is estimated or rounded up.
      </p>

      <h2>Post records and article text are different things</h2>
      <p>
        This is the one thing worth reading twice before you talk to us, because it is the thing
        most likely to be assumed wrongly.
      </p>
      <p>
        The <strong>post records</strong> are the large dataset: title, summary, author, canonical
        URL, publication date and the feed each post belongs to, {fmt(posts)} of them, growing by
        hundreds of thousands a day. That is metadata at scale, and for a great many uses — link
        graphs, recency signals, topic and language distribution, retrieval indexes — it is the part
        that matters.
      </p>
      <p>
        The <strong>article text</strong> is the smaller one
        {corpus ? `: ${fmt(corpus.articles)} articles` : ''}, sanitized, averaging{' '}
        {corpus ? `${fmt(corpus.sampledAvgChars)} characters` : 'several thousand characters'}{' '}
        {corpus ? (
          <>
            (sampled over {fmt(corpus.sampleSize)} of them, not summed over all — the exact figure
            is a quarter of a million row lookups this database should not be asked for on a page
            load)
          </>
        ) : null}
        . It exists because an article is fetched and cached when a reader opens the post, so it
        grows with attention rather than with the crawl. Posts ingested before August 2026 also
        carry the body their feed published; newer ones do not, because storing one for every post
        was ten gigabytes of a fourteen gigabyte database.
      </p>
      <p>
        If you need prose at the scale of the metadata, say so — that is a change to what the
        crawler stores rather than a parameter you can pass, and it is a conversation we are happy
        to have.
      </p>

      <h2>How it is delivered</h2>
      <p>
        Four streams — <code>feeds</code>, <code>items</code>, <code>extracts</code> and{' '}
        <code>authors</code> — each one gzipped NDJSON, one JSON object per line, streamed rather
        than downloaded from a prepared file. The full machine-readable description lives at{' '}
        <a href="/api/dataset">/api/dataset</a> and needs no account, so you can read the exact
        shape of every row before you talk to anybody.
      </p>
      <p>
        Every slice is a half-open range on a fixed {dataset.WINDOW_HOURS}-hour boundary, currently{' '}
        <code>{latestClosedWindow()}</code>. That matters more than it sounds: a window is the same
        set of rows whoever asks and whenever they ask, so a pipeline that walks boundaries in order
        provably sees every row exactly once — no gaps from clock skew, no duplicates from a retry,
        and a failed pull can simply be repeated. Only closed windows are served, because the one
        containing the present is still filling.
      </p>
      <p>
        Authenticate with a session or an API key as a bearer token. The licence belongs to the
        account rather than to the key, so keys can be rotated without telling us. A full-history
        pull is available too, separately metered — intended once, to seed a mirror, before
        switching to windows for good.
      </p>

      <h2>Where it comes from</h2>
      <p>
        Public feeds their publishers chose to syndicate. Anyone may{' '}
        <a href="/submit">submit a feed</a>, every feed has{' '}
        <a href="/blogs">its own page here</a>, and the directory has been open and free to read
        since the day it launched — <a href="/api/feeds">the JSON API</a>,{' '}
        <a href="/opml">the OPML export</a>, <a href="/llms.txt">llms.txt</a> and{' '}
        <a href="/mcp">the MCP server</a> all still answer without an account, and nothing on this
        page changes that. What is licensed here is bulk access, which is a different artifact and a
        real cost to serve.
      </p>
      <p>
        A publisher may be excluded from the corpus while staying in the directory, by writing to{' '}
        <a href="mailto:hello@rssamplifier.com">hello@rssamplifier.com</a>. It is a separate ask
        from removal on purpose — “list my blog, but do not sell my writing to a model” is a
        coherent position and nobody should have to leave the directory to hold it. Excluded feeds,
        and every post and article belonging to them, are absent from every stream.
        {corpus && corpus.optedOut > 0 ? ` ${fmt(corpus.optedOut)} have asked so far.` : ''}
      </p>

      <h2 id="enquire">Talk to us</h2>
      {sent ? (
        <p className="notice" role="status">
          Thank you — that is recorded and someone will reply to the address you gave. If you would
          rather chase it, <a href="mailto:hello@rssamplifier.com">hello@rssamplifier.com</a>{' '}
          reaches the same people.
        </p>
      ) : null}
      {error ? (
        <p className="notice" role="alert">
          {errorMessage(error)}
        </p>
      ) : null}
      <p>
        Licensing is per buyer, so there is no price list here: what you may keep, whether you may
        redistribute it and whether attribution travels with the text all move the number more than
        volume does. Tell us what you want it for and we will come back with terms.
      </p>

      {/* A plain form posting to /api/*, like every other control on this site:
          it works with JavaScript off, and the route answers an HTML caller with
          a 303 back to this anchor and a JSON caller with JSON. */}
      <form className="submit-box" action="/api/sales/contact" method="post">
        <p className="eyebrow">Only the email and the last box are required</p>
        <input
          name="name"
          type="text"
          autoComplete="name"
          maxLength={120}
          placeholder="Your name"
          aria-label="Your name"
        />
        <input
          name="email"
          type="email"
          autoComplete="email"
          maxLength={200}
          required
          placeholder="you@example.com"
          aria-label="Your email address"
        />
        <input
          name="org"
          type="text"
          autoComplete="organization"
          maxLength={160}
          placeholder="Company or project"
          aria-label="Company or project"
        />
        <textarea
          name="use_case"
          rows={5}
          maxLength={4000}
          required
          placeholder={
            'What do you want the corpus for?\n\nWhich streams you need, roughly what scale, how often you would pull, and what it is being used to build.'
          }
          aria-label="What do you want the corpus for?"
        />
        <p className="hint">
          The last box is the one that decides what we can offer, so it is the one worth writing.
          Rough is fine; vague costs us both a round trip.
        </p>

        {/* The honeypot: no human sees it, no browser fills it, and a bot that
            completes it gets the same success answer as everyone else — told it
            failed, it would only try again differently. Hidden from assistive
            technology as well as from sight, so a screen reader does not
            announce a field its user must leave alone. */}
        <p hidden aria-hidden="true">
          <input name="website" type="text" tabIndex={-1} autoComplete="off" />
        </p>

        <div className="submit-actions">
          <button type="submit">Send enquiry</button>
        </div>
      </form>

      <p>
        Prefer email? <a href="mailto:hello@rssamplifier.com">hello@rssamplifier.com</a>. For
        anything that is not about the corpus, <a href="/contact">the contact page</a> routes to the
        right mailbox.
      </p>

      <Toolbar />
    </>
  );
}

/**
 * @param {string} code
 * @returns {string}
 */
function errorMessage(code) {
  switch (code) {
    case 'bad-email':
      return 'That does not look like an email address — we would have no way to reply.';
    case 'no-use-case':
      return 'Please say what you want the corpus for. It is the field that decides what we can offer.';
    case 'too-many':
      return 'That is several enquiries in an hour. Email hello@rssamplifier.com directly and we will pick it up there.';
    default:
      return 'That did not send. Try again, or email hello@rssamplifier.com.';
  }
}

/**
 * @param {unknown} n
 * @returns {string}
 */
function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}
