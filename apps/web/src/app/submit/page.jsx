import { AD_TEXT } from '../../lib/ads.js';
import Ad from '../Ad.jsx';
import Toolbar from '../Toolbar.jsx';
import Uploader from './Uploader.jsx';

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

      {params.error === 'large' ? (
        <p className="notice">
          That file is too big to send in one piece. The uploader below reads it in your browser and
          sends the feeds a few thousand at a time instead, which has no size limit worth the name —
          but it needs JavaScript. With JavaScript off, split the file, or post the feeds to{' '}
          <code>/api/submit</code> yourself.
        </p>
      ) : (
        params.error && (
          <p className="notice">
            We could not find a feed at that address. Check the URL, or paste the feed or playlist
            link directly.
          </p>
        )
      )}

      {/*
       * Both forms live in the client component now, and they are still plain
       * forms: same action, same method, same behaviour with JavaScript off.
       * What it adds is the reading and batching that make a very large file
       * importable at all — see Uploader for why that cannot be done at the
       * server end.
       */}
      <Uploader shared={shared} />

      <h2>For agents</h2>
      <p>Same endpoint, JSON in and JSON out:</p>
      <pre className="snippet">{`curl -X POST https://rssamplifier.com/api/submit \\
  -H 'content-type: application/json' \\
  -d '{"urls":["example.com","another.blog"]}'`}</pre>

      <p>
        A catalogue too large to post in one request goes in the same way the uploader sends it —
        open a submission, add batches of feeds to it, then close it:
      </p>
      <pre className="snippet">{`curl -X POST https://rssamplifier.com/api/submit/begin \\
  -H 'content-type: application/json' \\
  -d '{"kind":"opml","sample":"<opml>…"}'
# → {"submissionId":"…","maxEntriesPerBatch":5000}

curl -X POST https://rssamplifier.com/api/submit/batch \\
  -H 'content-type: application/json' \\
  -d '{"submissionId":"…","offset":0,"entries":[{"url":"example.com/feed.xml"}]}'

curl -X POST https://rssamplifier.com/api/submit/finish \\
  -H 'content-type: application/json' \\
  -d '{"submissionId":"…"}'`}</pre>

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
