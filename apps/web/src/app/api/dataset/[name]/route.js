import { dataset } from '@rssamplifier/db';

import { db } from '../../../../lib/db.js';
import {
  datasetCaller,
  resolveWindow,
  latestClosedWindow,
  startOfUtcDay,
} from '../../../../lib/dataset.js';

export const dynamic = 'force-dynamic';

/**
 * One dataset, one slice, streamed as gzipped NDJSON.
 *
 * ## Why this streams instead of building a file
 *
 * There is nowhere to put a file. This deployment has no object storage, and the
 * database it would be built from is the same one serving the site — so a
 * "build a dump every four hours" job would be a large periodic read against a
 * write-saturated database, producing an artifact most windows nobody collects.
 * Streaming inverts it: the work happens when somebody actually wants the data,
 * nothing larger than one page is ever resident, and the buyer starts receiving
 * rows immediately rather than after the last one is read.
 *
 * The window boundaries are what make that safe to sell. A streamed response is
 * not obviously reproducible — but a slice cut on a fixed clock is the same set
 * of rows whoever asks, so "stream it twice and get the same corpus" holds
 * without an artifact existing anywhere in between. See `lib/dataset.js`.
 *
 * ## Why NDJSON and not CSV or Parquet
 *
 * Because the rows are not rectangular: a post carries an HTML body and an
 * author record carries a nested array of links, and both survive a line of JSON
 * unchanged. It is also the format that can be produced incrementally — a line
 * at a time, with no header to write first and no footer to get right — which is
 * what lets a dump be a stream at all. Parquet would be a better fit for a
 * buyer's storage and a worse fit for ours; converting on receipt is one line of
 * their pipeline.
 *
 * ## Why the count in the audit log can be short
 *
 * `finishDownload` runs when the stream closes cleanly. If the buyer hangs up
 * partway, it never runs, and the row keeps a null `completed_at` — which is the
 * signal that the pull broke rather than that it was small. That is deliberate:
 * a broken pull must still count against the window allowance, or hanging up
 * becomes a free way to run the query in a loop.
 */

/**
 * @param {Request} req
 * @param {{ params: Promise<{ name: string }> }} ctx
 * @returns {Promise<Response>}
 */
export async function GET(req, { params }) {
  const { name: raw } = await params;
  // `.jsonl.gz` is stripped rather than required, so a caller may write the URL
  // as a filename and get a file. Both spellings reach the same stream.
  const name = String(raw ?? '')
    .toLowerCase()
    .replace(/\.(ndjson|jsonl)(\.gz)?$/, '');

  const stream = dataset.streamFor(name);
  if (!stream) {
    return Response.json(
      {
        error: 'unknown-dataset',
        detail: `No dataset called "${name}".`,
        datasets: dataset.DATASETS,
        manifest: '/api/dataset',
      },
      { status: 404, headers: { 'access-control-allow-origin': '*' } },
    );
  }

  const caller = await datasetCaller(req);
  if (!caller.ok) return caller.response;

  const { user, grant, apiKeyId } = caller;
  const client = db();
  const url = new URL(req.url);
  const full = url.searchParams.get('full') === '1';

  // Two different allowances, because they bound two different costs. A window
  // is a bounded index range; a full dump walks the table.
  if (full) {
    const taken = await dataset.fullDumpCount(client, String(grant.id), startOfUtcDay());
    const allowed = Number(grant.full_dumps_per_day) || 0;
    if (taken >= allowed) {
      return exhausted(
        'full-dump-limit',
        `This licence allows ${allowed} full-history pull${allowed === 1 ? '' : 's'} a day and has used ${taken}. Incremental windows are not affected — take ${latestClosedWindow()} instead.`,
      );
    }
  }

  const slice = full
    ? { ok: true, start: null, end: null }
    : resolveWindow(url.searchParams.get('window'));

  if (!slice.ok) {
    return Response.json(
      { error: slice.error, detail: slice.detail, manifest: '/api/dataset' },
      { status: 400, headers: { 'access-control-allow-origin': '*' } },
    );
  }

  if (!full) {
    const taken = await dataset.windowDownloadCount(
      client,
      String(grant.id),
      name,
      String(slice.start),
    );
    const allowed = Number(grant.per_window_downloads) || 0;
    if (taken >= allowed) {
      return exhausted(
        'window-limit',
        `This licence allows ${allowed} pulls of one dataset per ${dataset.WINDOW_HOURS}-hour window, and has taken ${taken} of ${name} for ${slice.start}.`,
      );
    }
  }

  // Opened before the first byte, closed when the last one lands. See the note
  // at the top on why the order matters.
  const downloadId = await dataset.startDownload(client, {
    grantId: String(grant.id),
    userId: String(user.id),
    dataset: name,
    windowStart: full ? null : String(slice.start),
    fullDump: full,
    apiKeyId,
  });

  const encoder = new TextEncoder();
  let rows = 0;

  const lines = new ReadableStream({
    async start(controller) {
      try {
        for await (const row of stream(client, { since: slice.start, until: slice.end })) {
          controller.enqueue(encoder.encode(`${JSON.stringify(shape(name, row))}\n`));
          rows += 1;
        }
        await dataset.finishDownload(client, downloadId, rows);
      } catch (err) {
        // The response is already on the wire with a 200, so this cannot become
        // an error status — the same bind the OPML export is in. The download
        // row is left with a null `completed_at`, which is exactly the record of
        // "this one broke", and the buyer sees a truncated file rather than a
        // silently short one because the byte count will not match a re-pull of
        // the same window.
        console.error(`dataset stream failed partway: ${name}`, err);
      }
      controller.close();
    },
  });

  const filename = full
    ? `rssamplifier-${name}-full.jsonl.gz`
    : `rssamplifier-${name}-${String(slice.start).replace(/[:.]/g, '')}.jsonl.gz`;

  return new Response(lines.pipeThrough(new CompressionStream('gzip')), {
    headers: {
      'content-type': 'application/x-ndjson',
      'content-encoding': 'gzip',
      'content-disposition': `attachment; filename="${filename}"`,
      // The buyer's pipeline reads these to decide when to ask again, so they
      // are part of the interface rather than diagnostics.
      'x-dataset-name': name,
      'x-dataset-window': full ? 'full' : String(slice.start),
      'x-dataset-window-end': full ? '' : String(slice.end),
      'x-dataset-window-hours': String(dataset.WINDOW_HOURS),
      'x-dataset-next-window': latestClosedWindow(),
      // No caching anywhere in between: a window is stable but a licence is not,
      // and a proxy holding a corpus slice would serve it to the next caller.
      'cache-control': 'private, no-store',
      'access-control-allow-origin': '*',
    },
  });
}

/**
 * A row, as the buyer sees it.
 *
 * The database's column names are an implementation detail and several of them
 * would be actively misleading in a corpus — `cursor_rowid` is paging state that
 * means nothing outside this process, and `links` arrives from SQLite as a JSON
 * *string* that would otherwise land in the file double-encoded and have to be
 * parsed twice.
 *
 * Everything else keeps its snake_case name deliberately. The manifest describes
 * the columns, `/crawlstats` and the open API use the same vocabulary, and
 * renaming them here would mean the corpus and the documentation disagree.
 *
 * @param {string} name
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
function shape(name, row) {
  const { cursor_rowid: _cursor, ...rest } = row;

  if (name === 'authors' && typeof rest['links'] === 'string') {
    try {
      rest['links'] = JSON.parse(String(rest['links']));
    } catch {
      // json_group_array cannot really produce invalid JSON, but a corpus line
      // that fails to parse is worse than one whose links arrive as a string.
      rest['links'] = [];
    }
  }

  if (name === 'feeds' && typeof rest['categories'] === 'string') {
    try {
      rest['categories'] = JSON.parse(String(rest['categories']));
    } catch {
      rest['categories'] = [];
    }
  }

  return rest;
}

/**
 * @param {string} error
 * @param {string} detail
 * @returns {Response}
 */
function exhausted(error, detail) {
  return Response.json(
    { error, detail, manifest: '/api/dataset' },
    { status: 429, headers: { 'access-control-allow-origin': '*' } },
  );
}
