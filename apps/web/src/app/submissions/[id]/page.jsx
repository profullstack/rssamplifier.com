import { notFound } from 'next/navigation';
import { q } from '@rssamplifier/db';

import Toolbar from '../../Toolbar.jsx';
import AdBanner from '../../AdBanner.jsx';
import { db } from '../../../lib/db.js';

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

  const progress = await q.submissionProgress(client, id);
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

      {progress.queued > 0 && (
        <p className="notice">
          {percent}% of the queue has been crawled.
          {submission.notify_email
            ? submission.notified_at
              ? ' We have emailed you the result.'
              : ' We will email you when it finishes.'
            : ''}
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

      <Toolbar />
    </>
  );
}
