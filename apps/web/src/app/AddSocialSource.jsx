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
 * Facebook was the exception here for one revision, on the grounds that only a
 * Page's own administrator could connect it. That is no longer true: it is read
 * with a session like X and Instagram are, so it takes open submissions like
 * they do — see facebook/scrape.js for what that costs in reliability.
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
  facebook: {
    name: 'Facebook',
    index: '/fb',
    note: 'Facebook publishes no feeds and shows nothing without a login, so this is read on your behalf and mirrored here. It is the least reliable of the four by some distance — Facebook changes its markup often and without warning — and it is checked hourly rather than every few minutes, because asking faster is how the reading account gets locked.',
  },
};
