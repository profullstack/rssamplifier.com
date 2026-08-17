/**
 * The crawler's log, as lines a person can read.
 *
 * The poller writes structured rows — an event name, a subject, a number, and
 * whatever else that event had to say as JSON. Turning one into a sentence has
 * to happen in exactly one place, because the same line is rendered twice: as
 * text for a terminal tailing the stream, and as an element in the browser. Two
 * renderers drift, and a log that describes the same event two different ways is
 * worse than one that says less.
 */

/**
 * One database row as a plain object the client can hold.
 *
 * `detail` stays a string here. Half the events use it for a message and half
 * for a JSON payload, and deciding which is the renderer's job — a row that
 * cannot be parsed still has a line to show.
 *
 * @param {Record<string, unknown>} row
 * @returns {{ id: number, at: string, event: string, status: string|null, subject: string|null, slug: string|null, amount: number|null, detail: string|null, ms: number|null }}
 */
export function toLine(row) {
  return {
    id: Number(row.id),
    at: String(row.at),
    event: String(row.event),
    status: row.status == null ? null : String(row.status),
    subject: row.subject == null ? null : String(row.subject),
    slug: row.slug == null ? null : String(row.slug),
    amount: row.amount == null ? null : Number(row.amount),
    detail: row.detail == null ? null : String(row.detail),
    ms: row.ms == null ? null : Number(row.ms),
  };
}

/**
 * One log line as a sentence.
 *
 * Events the poller is known to emit get real wording; anything else falls back
 * to its name and its payload. The fallback is the important half: a log that
 * hides events it was not taught about is a log that goes quiet exactly when
 * somebody adds something worth watching.
 *
 * `name` decides whether the fallback repeats the event's name. The text form
 * prints the event in a column of its own, and a line reading
 * "crawl-error crawl-error database is locked" is the sort of thing that makes a
 * log look machine-generated in the bad sense.
 *
 * @param {{ event: string, subject?: string|null, amount?: number|null, detail?: string|null, ms?: number|null }} line
 * @param {{ name?: boolean }} [opts]
 * @returns {string}
 */
export function describe(line, { name = true } = {}) {
  const fields = payload(line.detail);
  const n = (value) => Number(value ?? 0).toLocaleString('en-US');

  switch (line.event) {
    case 'feed': {
      if (line.status === 'error') {
        return `${line.subject ?? 'a feed'} could not be crawled — ${line.detail ?? 'unknown'}`;
      }
      const posts = Number(line.amount ?? 0);
      return `crawled ${line.subject ?? 'a feed'} — ${
        posts === 0 ? 'nothing new' : `${n(posts)} new ${posts === 1 ? 'post' : 'posts'}`
      }`;
    }

    case 'crawl':
      // The tick summary. `due` is the number worth reading: the other three say
      // the tick did something, this one says whether the crawler is keeping up.
      return `batch done — ${n(fields.crawled)} crawled, ${n(fields.failed)} failed, ${n(
        fields.items,
      )} posts stored, ${n(fields.due)} still due`;

    case 'discovery-search':
      return `searched ${n(fields.searched)} ${
        Number(fields.searched ?? 0) === 1 ? 'keyword' : 'keywords'
      } — ${n(fields.queued)} sites to check${
        fields.fatal ? `, stopped: ${fields.fatal}` : fields.failed ? `, ${n(fields.failed)} failed` : ''
      }`;

    case 'discovery':
      return `checked ${n(fields.checked)} candidate ${
        Number(fields.checked ?? 0) === 1 ? 'site' : 'sites'
      } — ${n(fields.accepted)} added, ${n(fields.rejected)} rejected`;

    case 'discovery-source': {
      const name = fields.source ?? line.subject ?? 'a list';
      if (fields.error) return `${name} could not be read — ${fields.error}`;
      return `read ${name} — ${n(fields.found)} feeds listed, ${n(fields.queued)} new`;
    }

    case 'discovery-topics': {
      // The payload carries the keywords themselves, not a count — the same
      // shape 'migrated' below carries, and the poller has always sent it that
      // way. Passing it to n() asked Number() what ['home lab', 'rss'] is worth
      // and printed the answer: NaN.
      //
      // Both shapes are read because the line is worth showing either way, and
      // naming the terms is the useful half: "3 keywords queued" does not tell a
      // reader whether the directory is chasing something sensible.
      const terms = Array.isArray(fields.keywords) ? fields.keywords.map(String) : [];
      const count = terms.length || Number(fields.keywords ?? 0);
      const named = terms.length ? `: ${terms.join(', ')}` : '';
      return `looked for more of what we already cover — ${n(count)} ${
        count === 1 ? 'keyword' : 'keywords'
      } queued${named}`;
    }

    case 'topics':
      return `rebuilt the topics index — ${n(fields.topics)} topics`;

    case 'notified':
      return `emailed ${n(fields.sent)} submitters${fields.failed ? `, ${n(fields.failed)} failed` : ''}`;

    case 'notified-discovery':
      return `emailed ${n(fields.sent)} searchers${fields.failed ? `, ${n(fields.failed)} failed` : ''}`;

    case 'purged':
      return `cleared ${n(fields.rows)} expired sessions and challenges`;

    case 'purged-rollup':
      return `pruned ${n(fields.rows)} hours of throughput history`;

    case 'purged-log':
      return `pruned ${n(fields.rows)} old log lines`;

    case 'migrated':
      return `applied ${Array.isArray(fields.applied) ? fields.applied.join(', ') : 'migrations'}`;

    case 'started':
      return `crawler started — every ${n(fields.intervalSeconds)}s, ${n(
        fields.batchSize,
      )} feeds a batch, ${n(fields.concurrency)} hosts at once`;

    case 'stopping':
      return `crawler stopping — ${fields.signal ?? 'signal'}`;

    case 'log-dropped':
      return `${n(line.amount)} log lines were dropped — the crawler was writing faster than this log could record`;

    default: {
      // An unrecognised event, said plainly: the name, then whatever it carried.
      const parts = [];
      if (name) parts.push(line.event);
      if (line.subject) parts.push(line.subject);
      if (line.detail) parts.push(line.detail);
      return parts.join(' ');
    }
  }
}

/**
 * A log line as one line of a log file.
 *
 * Fixed-width-ish and in that order on purpose: a timestamp first so `sort` and
 * `grep` on a time work, then the level and the event so a reader can filter on
 * either without a parser.
 *
 * @param {object} line
 * @returns {string}
 */
export function textLine(line) {
  const level = (line.status ?? 'info').padEnd(5);
  const event = String(line.event).padEnd(16);
  const took = line.ms == null ? '' : ` (${Number(line.ms)}ms)`;

  return `${line.at} ${level} ${event} ${describe(line, { name: false })}${took}`;
}

/**
 * Good news, bad news, or neither.
 *
 * @param {{ status?: string|null }} line
 * @returns {'good'|'bad'|'plain'}
 */
export function tone(line) {
  if (line.status === 'error') return 'bad';
  if (line.status === 'ok') return 'good';
  return 'plain';
}

/**
 * The JSON an event carried, or nothing.
 *
 * @param {string|null|undefined} detail
 * @returns {Record<string, unknown>}
 */
function payload(detail) {
  if (!detail) return {};

  try {
    const parsed = JSON.parse(detail);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A message rather than a payload, which the callers that want it read
    // straight off the line.
    return {};
  }
}
