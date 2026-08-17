import { AD_TEXT } from '../../lib/ads.js';
import Ad from '../Ad.jsx';
import Toolbar from '../Toolbar.jsx';

export const metadata = {
  title: 'Submit a blog',
  description:
    'Add a URL, a playlist, a list of URLs or an OPML file to the directory. No account needed.',
};

/**
 * @param {{ searchParams: Promise<{ error?: string, url?: string, input?: string, title?: string }> }} props
 */
export default async function SubmitPage({ searchParams }) {
  const params = await searchParams;

  // The PWA manifest declares a share_target pointing here, so sharing a link
  // from a phone lands as ?url= (or ?input= for shared text). Prefill from
  // either so the flow is one tap.
  const shared = (params.url ?? params.input ?? '').trim();

  return (
    <>
      <h1>Submit a blog</h1>
      <p className="lede">
        Paste a homepage and we will find the feed. A playlist works too — an m3u, m3u8 or pls is
        read as a feed of what it lists, and a live stream lands under Live. No account, no waiting
        list, no fee.
      </p>

      {params.error && (
        <p className="notice">
          We could not find a feed at that address. Check the URL, or paste the feed or playlist
          link directly.
        </p>
      )}

      <form className="submit-box" action="/api/submit" method="post">
        <p className="eyebrow">One per line</p>
        <textarea
          name="input"
          rows={5}
          defaultValue={shared}
          placeholder={'example.com\nanotherblog.net/feed.xml\nnetlabel.example/album.m3u'}
          aria-label="URLs to submit"
          required
        />
        <div className="submit-actions">
          <button type="submit">Add to the directory</button>
        </div>
      </form>

      <form className="submit-box" action="/api/submit" method="post" encType="multipart/form-data">
        <p className="eyebrow">Or upload an OPML file</p>
        <input type="file" name="opml" accept=".opml,.xml,text/xml" aria-label="OPML file" />
        <p className="hint">
          Any size. The first 100 are added while you wait and the rest are queued for the crawler,
          so a catalogue of tens of thousands is fine — you will get a status page to watch.
        </p>
        <input
          type="email"
          name="email"
          placeholder="you@example.com — optional, we will email you when it finishes"
          aria-label="Email me when the import finishes"
        />
        <div className="submit-actions">
          <button type="submit">Import subscriptions</button>
        </div>
      </form>

      <h2>For agents</h2>
      <p>Same endpoint, JSON in and JSON out:</p>
      <pre className="snippet">{`curl -X POST https://rssamplifier.com/api/submit \\
  -H 'content-type: application/json' \\
  -d '{"urls":["example.com","another.blog"]}'`}</pre>

      {/*
       * The only ad on the funnel, and it is below everything: both forms, the
       * hint text and the API example. Putting inventory above a conversion
       * step buys pennies of impression against whatever the conversion is
       * worth, and here the conversion is the directory itself growing.
       */}
      <Ad format={AD_TEXT} />

      <Toolbar />
    </>
  );
}
