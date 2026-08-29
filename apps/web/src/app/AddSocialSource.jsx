import { siteUrl } from '../lib/db.js';

/**
 * What `/r/somewhere`, `/x/somebody`, `/ig/somebody` or `/fb/SomePage` shows
 * when it is not in the directory yet.
 *
 * A 404 would be the easy answer and the wrong one for three of the four. The
 * address is well formed, the thing at the other end almost certainly exists,
 * and the visitor has already said exactly what they want by typing it — so the
 * page offers to add it rather than telling them they were wrong to ask.
 *
 * A plain `<form method="post">` to `/api/submit`, like every other control on
 * this site: it works with JavaScript off, and the endpoint answers an HTML
 * caller with a 303 back to the source's own page. Nothing is fetched from the
 * platform while the visitor waits — the row is written, the poller collects on
 * its next tick, and this page is replaced by the real one within the minute
 * (§17, §37).
 *
 * **Facebook is the exception, and says so.** There is no public feed, no
 * unauthenticated HTML and no provider; the only way in is a Page Access Token
 * from whoever administers the Page. Offering an "add" button there would be a
 * button that quietly does nothing, so it gets an explanation instead.
 *
 * @param {{ network: 'x'|'reddit'|'instagram'|'facebook', label: string, input: string, canonical: string }} props
 *   `input` is what gets submitted — the canonical upstream URL, not what was
 *   typed, so the source that gets created is the one this page is about.
 */
export default function AddSocialSource({ network, label, input, canonical }) {
  const platform = PLATFORMS[network] ?? PLATFORMS.x;
  const address = (
    <>
      <code>
        {siteUrl()}
        {canonical}
      </code>{' '}
      in every format this site publishes: <code>.rss</code>, <code>.atom</code>,{' '}
      <code>.json</code> and <code>.md</code>
    </>
  );

  if (network === 'facebook') {
    return (
      <main className="prose">
        <h1>{label}</h1>

        <p>
          This Facebook Page is not connected, and unlike the rest of the directory it cannot be
          added by anyone who happens to want it.
        </p>

        <p>
          Facebook publishes no feed for a Page, serves no page without a login, and has no
          third-party bridge we can use. The only remaining route is Meta&rsquo;s own Graph API,
          and it will only return a Page&rsquo;s posts to somebody who <strong>administers that
          Page</strong> — reading a stranger&rsquo;s public Page needs a permission Meta grants
          rarely and only after review.
        </p>

        <p>
          So if this is your Page, it can be connected: an administrator supplies a Page Access
          Token and it appears here at {address}, collected on the same schedule as everything
          else. If it is not your Page, there is nothing we can honestly offer — and we would
          rather say that than mirror a scraper that breaks every few weeks.
        </p>

        <p>
          <a href="/fb">What is connected</a> · <a href="/x">X</a> · <a href="/ig">Instagram</a> ·{' '}
          <a href="/r">Reddit</a>
        </p>
      </main>
    );
  }

  return (
    <main className="prose">
      <h1>{label}</h1>

      <p>
        Nobody has added this {platform.name} source to the directory yet. Add it and RSS Amplifier
        will start collecting it — usually within a minute.
      </p>

      <form method="post" action="/api/submit">
        <input type="hidden" name="input" value={input} />
        <button type="submit">Add {label} to the directory</button>
      </form>

      <p>Once it is here, it will be at {address}. That address does not change, whatever we have
        to do behind it to keep collecting.</p>

      <p>{platform.note}</p>

      <p>
        <a href={platform.index}>Browse what is already here</a>
      </p>
    </main>
  );
}

/** What to call each platform, and the one thing worth saying about it. */
const PLATFORMS = {
  x: {
    name: 'X',
    index: '/x',
    note: 'X publishes no feeds of its own, so this is collected on your behalf and mirrored here. Protected accounts are not collected, and posts arrive as fast as we can read them rather than in real time.',
  },
  reddit: {
    name: 'Reddit',
    index: '/r',
    note: 'Reddit publishes its own feed for this, and we read it on a schedule and keep a copy — so the address above works whether or not Reddit is answering right now.',
  },
  instagram: {
    name: 'Instagram',
    index: '/ig',
    note: 'Instagram publishes no feeds, so this is collected on your behalf and mirrored here. Private accounts are not collected, and stories are not either — they expire, and a feed of things that have already gone is worse than no feed.',
  },
};
