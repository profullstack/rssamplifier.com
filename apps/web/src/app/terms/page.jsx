import { reliability } from '../../lib/reliability.js';
import Toolbar from '../Toolbar.jsx';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Terms',
  description:
    'What RSS Amplifier is, what it promises about freshness and availability, and what it does not.',
};

/**
 * The terms of use, and the service commitment.
 *
 * Written from what the code actually does and what the database actually
 * measures, in the same spirit as /privacy — which means the availability
 * section carries numbers rather than a target.
 *
 * That is a deliberate refusal, and it is the whole argument of the page. A
 * published uptime figure is a claim about the future that no reader can check
 * and that gets more embarrassing the worse the service gets; measured numbers
 * are claims about the past that anybody can check and that get better as the
 * service does. This directory is asking machines to trust it, and it has just
 * spent considerable effort making feed staleness visible rather than hidden —
 * hiding its own would be the same failure pointed inward.
 *
 * If a hard SLA is ever wanted here, it should follow evidence rather than
 * precede it: run the measurement below for a few months, see what the service
 * actually does, and promise something under that.
 */
export default async function TermsPage() {
  const stats = await reliability();

  const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—');
  const num = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

  return (
    <>
      <Toolbar />

      <h1>Terms</h1>
      <p className="lede">
        RSS Amplifier is an open directory of public feeds. Reading it needs no account, no key and
        no agreement. These terms describe what the service does, what it commits to, and what it
        deliberately does not.
      </p>

      <h2>Using the directory</h2>
      <p>
        Every page, feed, JSON endpoint and MCP tool here is public and anonymous. You may read it,
        crawl it, cache it, index it, and build on it, by hand or with an agent, commercially or
        otherwise. We do not rate-limit reads and we do not ask you to identify yourself. The one
        write — submitting a feed — carries a per-IP limit so that one submitter cannot fill the
        queue.
      </p>
      <p>
        The content itself is not ours. Titles, summaries and article text belong to the people who
        published them, and the directory indexes them the way a search engine does. If you are a
        publisher and you would rather not be listed, say so and the feed comes out.
      </p>

      <h2>What we commit to</h2>
      <p>
        One thing, and it is the thing an automated reader actually needs:{' '}
        <strong>every feed carries an honest freshness signal, and it is never hidden.</strong> Each
        feed page and every API and MCP response says when we last read the publisher, when the
        publisher last posted, and when we will look again. A feed whose publisher has gone quiet is
        labelled dormant even though our copy of it is perfectly current.
      </p>
      <p>
        This matters more than a speed or uptime figure because it is the failure that does real
        damage. A directory that is briefly down is obvious and recoverable. A directory that
        silently serves a blog which stopped publishing in 2023, with no indication that anything is
        wrong, produces confidently wrong answers — and about a sixth of the feeds in here are in
        exactly that state.
      </p>
      <p>
        How often we re-read a feed follows the feed&rsquo;s own publishing rhythm rather than a
        fixed schedule: something that posts hourly is checked hourly, and something that has posted
        nothing for two years is checked roughly quarterly. A feed is never left unchecked for more
        than ninety days, whatever it looks like, because publishers do come back.
      </p>

      <h2>Availability</h2>
      <p>
        <strong>We do not offer a service level agreement, and we do not publish an uptime
        target.</strong> This is a free, open service run on ordinary infrastructure by a small
        team, and a number like &ldquo;99.999%&rdquo; would be a promise we cannot presently keep —
        five nines is five minutes of downtime a year. Publishing one would be exactly the kind of
        confident, unverifiable claim this directory exists to protect its readers from.
      </p>
      <p>
        What we publish instead is what we measure. These figures are live, and they are the same
        numbers we use to run the service:
      </p>

      {stats ? (
        <>
          <div className="stat-grid">
            <Stat
              label="Crawler active"
              value={pct(stats.hoursRecorded, stats.hoursInWindow)}
              note={`${num(stats.hoursRecorded)} of ${num(stats.hoursInWindow)} hours observed`}
            />
            <Stat
              label="Crawl success"
              value={stats.successRate === null ? '—' : `${(stats.successRate * 100).toFixed(1)}%`}
              note={`${num(stats.succeededLastDay)} of ${num(stats.fetchedLastDay)} in 24h`}
            />
            <Stat label="Feeds indexed" value={num(stats.feeds)} note={`${num(stats.active)} read at least once`} />
            <Stat
              label="Dormant"
              value={stats.dormant === null ? '—' : num(stats.dormant)}
              note="no post in over a year"
            />
          </div>

          <p className="detail">
            &ldquo;Crawler active&rdquo; is the share of hours in which the crawler recorded work,
            measured over the {num(stats.hoursInWindow)} hours we have records for rather than over
            a calendar month — we have not been keeping this record long enough to claim more, and
            an absent hour is an hour with no evidence rather than a proven outage. It says nothing
            about whether this website answered, which is a different question we do not yet
            measure and will not guess at.
          </p>
          <p className="detail">
            &ldquo;Crawl success&rdquo; is partly a measure of the open web rather than of us: a
            feed that has moved, expired or started refusing robots counts as a failure here and is
            not something we can fix. The{' '}
            <a href="/crawlstats">crawler status page</a> shows the same figures hour by hour, live.
          </p>
        </>
      ) : (
        <p className="detail">
          The live figures are unavailable at the moment. Rather than show you a fabricated number,
          this section is blank — the <a href="/crawlstats">crawler status page</a> reads the same
          data directly.
        </p>
      )}

      <h2>What we do not promise</h2>
      <ul>
        <li>
          <strong>That a feed is complete.</strong> We store what a feed document offered when we
          read it. A publisher who serves only their ten most recent posts has an archive here that
          begins when we first found them.
        </li>
        <li>
          <strong>That a feed is accurate.</strong> Titles, dates, categories and authorship are the
          publisher&rsquo;s claims, not ours. Where we derive something ourselves — a category, a
          topic — we say so.
        </li>
        <li>
          <strong>That the service will keep existing.</strong> Should it ever shut down, the whole
          directory is published as <a href="/opml">OPML</a> and JSON so it can be taken elsewhere,
          and the code is <a href="https://github.com/profullstack/rssamplifier.com" rel="noopener">open source</a>.
        </li>
        <li>
          <strong>Anything, warranty-wise.</strong> The service is provided as is. We are not liable
          for decisions made on the strength of what it returns, which is why the freshness signal
          above is a commitment and this section is not.
        </li>
      </ul>

      <h2>Changes</h2>
      <p>
        These terms change when the service does, and the history is public in the{' '}
        <a href="https://github.com/profullstack/rssamplifier.com" rel="noopener">repository</a> like
        everything else here. Questions, corrections and removal requests:{' '}
        <a href="/contact">get in touch</a>.
      </p>
    </>
  );
}

/**
 * @param {{ label: string, value: string, note: string }} props
 */
function Stat({ label, value, note }) {
  // Value before label, matching the tiles on /crawlstats — the CSS orders on
  // source position, so swapping these renders a correct page upside down.
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}
