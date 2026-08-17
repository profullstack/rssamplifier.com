import Link from 'next/link';
import { notFound } from 'next/navigation';
import { discovery } from '@rssamplifier/db';

import AutoRefresh from '../../AutoRefresh.jsx';
import LiveProgress from '../../LiveProgress.jsx';
import Toolbar from '../../Toolbar.jsx';
import AdBanner from '../../AdBanner.jsx';
import { db } from '../../../lib/db.js';
import { RUN_ERRORS, explain } from '../../../lib/reasons.js';
import { streamSrc } from '../../../lib/sse.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Keyword search status',
  description: 'Progress of a keyword discovery run: what was searched, checked, added and why.',
};

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

  const [keywords, candidates, accepted, rejected, events] = await Promise.all([
    discovery.keywordProgress(client, id),
    discovery.runProgress(client, id),
    discovery.acceptedForRun(client, id, 100),
    discovery.rejectedForRun(client, id, 50),
    // The log's recent history, so it is populated on arrival rather than only
    // from whatever happens next.
    discovery.eventsForRun(client, id, { limit: 60, tail: true }),
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

  // A run has two queues and the bar has to cover both, or it sits at 100%
  // while a hundred keywords are still waiting to be searched.
  const totalSteps = keywords.total + candidates.total;
  const settledSteps = totalSteps - keywords.waiting - candidates.waiting;

  // Rows become plain objects here rather than in the component: everything
  // crossing into a client component has to be serialisable, and a libSQL row
  // carries values React will not send.
  const lines = events.map((row) => ({
    kind: String(row.kind),
    subject: String(row.subject ?? ''),
    status: String(row.status ?? ''),
    detail: row.detail == null ? null : String(row.detail),
    slug: row.slug == null ? null : String(row.slug),
    amount: row.amount == null ? null : Number(row.amount),
    at: String(row.at),
  }));

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

      {run.error && <p className="notice">{RUN_ERRORS[String(run.error)] ?? String(run.error)}</p>}

      {/*
       * Rendered whether or not the run is still going: a finished run keeps a
       * full bar and its log, which is the difference between "it worked" and
       * "something happened and I have no idea what".
       */}
      <LiveProgress
        src={streamSrc(`/api/discoveries/${id}/stream`, lines)}
        lines={lines}
        unit="steps"
        verb="Search"
        initial={{
          total: totalSteps,
          settled: settledSteps,
          percent: totalSteps === 0 ? 0 : Math.floor((settledSteps / totalSteps) * 100),
          done: !working,
        }}
      />

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

      {/*
       * The stream carries the bar and the log; this is only what fills in the
       * lists of blogs below them, so it can be slow. Both were 15s before, and
       * two things refreshing the same page that often is just noise.
       */}
      {working && <AutoRefresh seconds={30} />}
      <Toolbar />
    </>
  );
}
