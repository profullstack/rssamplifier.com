import { siteUrl } from '../lib/db.js';

/**
 * What `/r/somewhere` or `/x/somebody` shows when nobody has added it yet.
 *
 * A 404 would be the easy answer and the wrong one. The address is well formed,
 * the thing at the other end almost certainly exists, and the visitor has
 * already told us exactly what they want by typing it — so the page offers to
 * add it rather than telling them they were wrong to ask.
 *
 * A plain `<form method="post">` to `/api/submit`, like every other control on
 * this site: it works with JavaScript off, and the endpoint answers an HTML
 * caller with a 303 back to the source's own page. Nothing is fetched from X or
 * Reddit while the visitor waits — the row is written, the poller collects on
 * its next tick, and this page is replaced by the real one within the minute
 * (§17, §37).
 *
 * @param {{ network: 'x'|'reddit', label: string, input: string, canonical: string }} props
 *   `input` is what gets submitted — the canonical upstream URL, not what was
 *   typed, so the source that gets created is the one this page is about.
 */
export default function AddSocialSource({ network, label, input, canonical }) {
  const platform = network === 'x' ? 'X' : 'Reddit';

  return (
    <main className="prose">
      <h1>{label}</h1>

      <p>
        Nobody has added this {platform} source to the directory yet. Add it and RSS Amplifier
        will start collecting it — usually within a minute.
      </p>

      <form method="post" action="/api/submit">
        <input type="hidden" name="input" value={input} />
        <button type="submit">Add {label} to the directory</button>
      </form>

      <p>
        Once it is here, it will be at{' '}
        <code>
          {siteUrl()}
          {canonical}
        </code>{' '}
        in every format this site publishes:{' '}
        <code>.rss</code>, <code>.atom</code>, <code>.json</code> and <code>.md</code>. That
        address does not change, whatever we have to do behind it to keep collecting.
      </p>

      {network === 'x' ? (
        <p>
          X publishes no feeds of its own, so this is collected on your behalf and mirrored here.
          Protected accounts are not collected, and posts arrive as fast as we can read them
          rather than in real time.
        </p>
      ) : (
        <p>
          Reddit publishes its own feed for this, and we read it on a schedule and keep a copy —
          so the address above works whether or not Reddit is answering right now.
        </p>
      )}

      <p>
        <a href={network === 'x' ? '/x' : '/r'}>Browse what is already here</a>
      </p>
    </main>
  );
}
