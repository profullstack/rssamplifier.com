import Link from 'next/link';
import { notFound } from 'next/navigation';
import { discovery } from '@rssamplifier/db';

import AutoRefresh from '../../AutoRefresh.jsx';
import Toolbar from '../../Toolbar.jsx';
import AdBanner from '../../AdBanner.jsx';
import { db } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Keyword search status',
  description: 'Progress of a keyword discovery run: what was searched, checked, added and why.',
};

/** Provider errors, in words a person can act on. */
const ERRORS = {
  'no-api-key': 'Search is not configured on this server, so nothing could be searched.',
  'bad-api-key': 'The search provider rejected our credentials. Nothing could be searched.',
  'quota-exhausted':
    'The month’s search credits are spent. Remaining keywords stay queued and will run once the plan resets.',
  'rate-limited': 'The search provider is rate-limiting us. Remaining keywords stay queued.',
};

/** Rejection reasons, in words. */
const REASONS = {
  'already-indexed': 'already in the directory',
  'comments-feed': 'a comment feed, not a blog',
  'partial-feed': 'a tag or category feed',
  'too-few-items': 'too few entries',
  abandoned: 'nothing posted in over 18 months',
  'duplicate-titles': 'every entry has the same title',
  'unlinked-items': 'entries link nowhere',
  undated: 'no dates on any entry',
  untitled: 'no title',
  'low-score': 'did not score high enough',
  'no-feed-found': 'no feed on the site',
  timeout: 'site did not respond',
  'fetch-failed': 'site could not be reached',
  'blocked-host': 'not a public address',
};

/**
 * Turn a stored reason — a JSON array of codes, or a single code — into prose.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function explain(raw) {
  const value = String(raw ?? '');
  if (!value) return 'unknown';

  let codes = [value];
  if (value.startsWith('[')) {
    try {
      codes = JSON.parse(value);
    } catch {
      codes = [value];
    }
  }

  const words = codes.map((code) => REASONS[code] ?? String(code));
  return words.length > 0 ? words.join(', ') : 'unknown';
}

/**
 * Progress page for one keyword run.
 *
 * A run has two queues behind it — keywords still to search, sites still to
 * check — and both drain over minutes to hours. This is the page that makes
 * that visible, including the rejections: "we checked 900 sites and added 12"
 * is only believable if you can see what the other 888 were.
 *
 * @param {{ params: Promise<{ id: string }> }} props
 */
export default async function DiscoveryPage({ params }) {
  const { id } = await params;
  const client = db();

  const run = await discovery.runById(client, id);
  if (!run) notFound();

  const [keywords, candidates, accepted, rejected] = await Promise.all([
    discovery.keywordProgress(client, id),
    discovery.runProgress(client, id),
    discovery.acceptedForRun(client, id, 100),
    discovery.rejectedForRun(client, id, 50),
  ]);

  let terms = [];
  try {
    terms = JSON.parse(String(run.keywords ?? '[]'));
  } catch {
    terms = [];
  }

  const failed = String(run.status) === 'failed';
  const working = keywords.waiting > 0 || candidates.waiting > 0;
  const checked = candidates.total - candidates.waiting;

  return (
    <>
      <h1>
        {failed ? 'Search failed' : working ? 'Searching' : 'Search finished'}
      </h1>

      <p className="lede">
        {failed
          ? 'Nothing could be searched.'
          : working
            ? `${keywords.waiting.toLocaleString()} keywords and ${candidates.waiting.toLocaleString()} sites still queued. This page updates itself — it is safe to close and come back.`
            : `${terms.length} ${terms.length === 1 ? 'keyword' : 'keywords'} searched, ${checked.toLocaleString()} sites checked, ${candidates.accepted.toLocaleString()} blogs added.`}
      </p>

      {run.error && <p className="notice">{ERRORS[String(run.error)] ?? String(run.error)}</p>}

      <dl className="stats">
        <div>
          <dt>Keywords searched</dt>
          <dd>
            {keywords.searched.toLocaleString()} / {keywords.total.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt>Sites found</dt>
          <dd>{candidates.total.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Blogs added</dt>
          <dd>{candidates.accepted.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Still queued</dt>
          <dd>{candidates.waiting.toLocaleString()}</dd>
        </div>
      </dl>

      {terms.length > 0 && (
        <>
          <h2>Keywords</h2>
          <p>{terms.join(' · ')}</p>
        </>
      )}

      {accepted.length > 0 && (
        <>
          <h2>Blogs added</h2>
          <ul className="results">
            {accepted.map((row) => (
              <li key={String(row.slug)}>
                <Link href={`/${row.slug}`}>{String(row.title ?? row.host)}</Link>{' '}
                <span className="muted">
                  {String(row.host)}
                  {row.keyword ? ` — found via “${row.keyword}”` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {rejected.length > 0 && (
        <>
          <h2>Not added</h2>
          <ul className="results">
            {rejected.map((row) => (
              <li key={`${row.host}`}>
                <span>{String(row.host)}</span> <span className="muted">{explain(row.reason)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {run.notify_email && candidates.waiting > 0 && (
        <p className="notice">
          {run.notified_at
            ? 'We have emailed you the result.'
            : 'We will email you when it finishes.'}
        </p>
      )}

      <h2>For agents</h2>
      <p>The same status as JSON, safe to poll:</p>
      <pre className="snippet">{`curl https://rssamplifier.com/api/discoveries/${id}`}</pre>

      <AdBanner />

      {working && <AutoRefresh seconds={15} />}
      <Toolbar />
    </>
  );
}
