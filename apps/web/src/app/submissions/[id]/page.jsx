import { notFound } from 'next/navigation';
import { q } from '@rssamplifier/db';

import AutoRefresh from '../../AutoRefresh.jsx';
import LiveProgress from '../../LiveProgress.jsx';
import Toolbar from '../../Toolbar.jsx';
import AdBanner from '../../AdBanner.jsx';
import { db } from '../../../lib/db.js';
import { streamSrc } from '../../../lib/sse.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Import status',
  description: 'Progress of a queued submission to the directory.',
};

/**
 * Progress page for a queued submission.
 *
 * A catalogue upload is crawled over hours, long after the tab that started it
 * would normally be closed. This is the page that makes the queue visible
 * instead of leaving the submitter guessing whether anything happened.
 *
 * @param {{ params: Promise<{ id: string }> }} props
 */
export default async function SubmissionPage({ params }) {
  const { id } = await params;
  const client = db();

  const submission = await q.submissionById(client, id);
  if (!submission) notFound();

  const [progress, events] = await Promise.all([
    q.submissionProgress(client, id),
    q.submissionEvents(client, id, { limit: 60, tail: true }),
  ]);

  // Serialisable plain objects — a libSQL row cannot cross into a client
  // component as it stands.
  const lines = events.map((row) => ({
    kind: 'feed',
    subject: String(row.title ?? row.slug ?? ''),
    status: String(row.status ?? ''),
    detail: row.last_error == null ? null : String(row.last_error),
    slug: row.slug == null ? null : String(row.slug),
    amount: row.item_count == null ? null : Number(row.item_count),
    at: String(row.at),
  }));

  const added = Number(submission.accepted_count ?? 0);
  const done = progress.waiting === 0;
  const settled = progress.crawled + progress.failed;
  const percent = progress.queued === 0 ? 100 : Math.floor((settled / progress.queued) * 100);

  return (
    <>
      <h1>{done ? 'Import finished' : 'Import in progress'}</h1>

      <p className="lede">
        {done
          ? `Everything you submitted has been crawled. ${added + progress.crawled} blogs are in the directory.`
          : `${progress.waiting.toLocaleString()} feeds still queued. This page updates as the crawler works through them — it is safe to close and come back.`}
      </p>

      <LiveProgress
        src={streamSrc(`/api/submissions/${id}/stream`, lines)}
        lines={lines}
        unit="feeds"
        verb="Crawl"
        initial={{ total: progress.queued, settled, percent, done }}
      />

      <dl className="stats">
        <div>
          <dt>Added immediately</dt>
          <dd>{added.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Queued for the crawler</dt>
          <dd>{progress.queued.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Crawled so far</dt>
          <dd>{progress.crawled.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Not reachable</dt>
          <dd>{progress.failed.toLocaleString()}</dd>
        </div>
      </dl>

      {/* The percentage moved into the bar; this is only the email promise. */}
      {progress.queued > 0 && submission.notify_email && (
        <p className="notice">
          {submission.notified_at
            ? 'We have emailed you the result.'
            : 'We will email you when it finishes.'}
        </p>
      )}

      <h2>For agents</h2>
      <p>The same status as JSON, safe to poll:</p>
      <pre className="snippet">{`curl https://rssamplifier.com/api/submissions/${id}`}</pre>

      {/*
       * A long import is watched, not read — the tab sits open for hours. That
       * is real attention, so it carries one unit, but below the status: the
       * numbers are the reason the page exists.
       */}
      <AdBanner />

      {/*
       * This page had nothing of the sort: an import was watched by reloading
       * it by hand. The stream drives the bar and the log; this fills in the
       * counts around them while the crawler works.
       */}
      {!done && <AutoRefresh seconds={30} />}

      <Toolbar />
    </>
  );
}
