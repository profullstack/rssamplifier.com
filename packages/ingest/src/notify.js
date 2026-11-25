import { q, discovery } from '@rssamplifier/db';
import { sendEmail, emailEnabled } from '@rssamplifier/mail';
import { promoBlock, hostOf } from '@profullstack/cross-promo';

/**
 * Telling submitters their import finished.
 *
 * A queued catalogue can take hours to crawl, which is far longer than anyone
 * will keep a tab open. The status page covers people who bookmark it; this
 * covers the rest.
 *
 * Email is optional infrastructure: with no RESEND_API_KEY configured the
 * whole path turns into a no-op rather than an error, because a directory that
 * cannot send mail should still accept submissions.
 */

export { emailEnabled };

const siteUrl = () => process.env['SITE_URL'] || 'https://rssamp.com';

/**
 * The "more from the network" block, after a blank line, for the end of a
 * text-only note. Submitters run blogs, so the reader is a publisher. Never
 * throws and never promotes RSSAmp itself; an empty block adds nothing.
 *
 * @param {string} to
 * @returns {Promise<string>}
 */
async function promoText(to) {
  const promo = await promoBlock({ site: hostOf(siteUrl()), audience: 'publishers', seed: to });
  return promo.text ? `\n\n${promo.text}` : '';
}

/**
 * Why a feed was not added, in a few words. The same codes the status page
 * explains (apps/web/src/lib/reasons.js); kept short here because a mail is
 * read once and the page has the long form.
 */
const REASONS = {
  'no-feed-found': 'no feed found on the site',
  'invalid-url': 'not a usable address',
  'no-feeds-in-opml': 'the file held no feeds',
  timeout: 'the site did not respond',
  'fetch-failed': 'the site could not be reached',
  'connection-failed': 'the site refused the connection',
  'tls-failed': 'the site has a broken HTTPS certificate',
  'dns-failed': 'the site name does not resolve',
  'blocked-host': 'not a public address',
  'blocked-redirect': 'it redirected somewhere we will not follow',
  removed: 'the owner asked us not to list it',
};

/**
 * @param {unknown} code
 * @returns {string}
 */
export function reasonWords(code) {
  const value = String(code ?? '').trim();
  if (!value) return 'it could not be read';
  if (REASONS[value]) return REASONS[value];
  const http = /^http-(\d{3})$/.exec(value);
  if (http) return `the site answered HTTP ${http[1]}`;
  // A raw exception message is not for a submitter; one line of it at most.
  return value.length > 80 ? 'it could not be read' : value;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * @typedef {{
 *   slug?: string|null,
 *   url?: string|null,
 *   title?: string|null,
 *   path?: string|null,
 *   outcome: 'added'|'listed'|'failed'|'waiting',
 *   reason?: string|null,
 * }} NoticeFeed
 */

/**
 * Send one submission notice.
 *
 * @param {Parameters<typeof submissionEmail>[0]} params
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
export async function sendSubmissionEmail(params) {
  return sendEmail(await submissionEmail(params));
}

/**
 * The "your feed is listed" note, built but not sent.
 *
 * One note per submission, never one per feed: a list of five hundred names
 * its first twenty and gives the counts and the status page for the rest.
 * Failures are said plainly with the reason, in the same note.
 *
 * @param {{
 *   to: string,
 *   submissionId: string,
 *   added: number,
 *   listed?: number,
 *   failed: number,
 *   feeds?: NoticeFeed[],
 * }} params
 * @returns {Promise<{ to: string, subject: string, text: string, html: string }>}
 */
export async function submissionEmail(params) {
  const site = siteUrl();
  const statusUrl = `${site}/submissions/${params.submissionId}`;
  const added = Math.max(0, Number(params.added) || 0);
  const listed = Math.max(0, Number(params.listed) || 0);
  const failed = Math.max(0, Number(params.failed) || 0);
  const inDirectory = added + listed;
  const total = inDirectory + failed;
  const feeds = (params.feeds ?? []).slice(0, 20);
  const more = Math.max(0, total - feeds.length);

  const plural = (n, one, many) => (n === 1 ? one : many);

  let subject;
  let lead;
  if (total === 0) {
    subject = 'Your RSSAmp submission is done';
    lead = 'Thanks for your submission. Everything in it was already in the directory, so there was nothing new to add.';
  } else if (inDirectory > 0 && total === 1) {
    subject = 'Your feed is listed on RSSAmp';
    lead = listed ? 'Thanks for your submission. That feed was already in the directory, so it is listed.' : 'Thanks for your submission. Your feed is now in the directory.';
  } else if (inDirectory > 0) {
    subject =
      inDirectory === total
        ? `All ${total} of your feeds are listed on RSSAmp`
        : `${inDirectory} of your ${total} feeds are listed on RSSAmp`;
    lead = `Thanks for your submission. ${inDirectory} of ${total} ${plural(total, 'feed is', 'feeds are')} now in the directory.`;
  } else {
    subject = `We could not add your ${plural(total, 'feed', 'feeds')} to RSSAmp`;
    lead = `Thanks for your submission. We could not add ${total === 1 ? 'it' : `any of the ${total}`}, and here is why.`;
  }

  /** @param {NoticeFeed} f */
  const label = (f) => String(f.title || f.slug || f.url || 'Untitled').slice(0, 120);
  /** @param {NoticeFeed} f */
  const link = (f) => (f.slug ? `${site}${f.path || `/${f.slug}`}` : f.url || '');
  /** @param {NoticeFeed} f */
  const outcome = (f) =>
    f.outcome === 'added'
      ? 'Added'
      : f.outcome === 'listed'
        ? 'Already listed'
        : f.outcome === 'waiting'
          ? 'Still in the queue'
          : `Not added: ${reasonWords(f.reason)}`;

  const counts = [
    `  Added:          ${added}`,
    ...(listed ? [`  Already listed: ${listed}`] : []),
    ...(failed ? [`  Not added:      ${failed}`] : []),
  ];

  const lines = [
    lead,
    ``,
    ...counts,
    ``,
    ...feeds.map((f) => `- ${label(f)}: ${outcome(f)}${link(f) ? `\n  ${link(f)}` : ''}`),
    ...(more > 0 ? [``, `And ${more} more.`] : []),
    ``,
    `Full status: ${statusUrl}`,
  ];

  const promo = await promoBlock({ site: hostOf(site), audience: 'publishers', seed: params.to });

  const htmlFeeds = feeds
    .map((f) => {
      const href = link(f);
      const name = escapeHtml(label(f));
      return `<li>${href ? `<a href="${escapeHtml(href)}">${name}</a>` : name}: ${escapeHtml(outcome(f))}</li>`;
    })
    .join('');

  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#111">`,
    `<p>${escapeHtml(lead)}</p>`,
    `<p>${counts.map((c) => escapeHtml(c.trim())).join('<br>')}</p>`,
    htmlFeeds ? `<ul>${htmlFeeds}</ul>` : '',
    more > 0 ? `<p>And ${more} more.</p>` : '',
    `<p><a href="${escapeHtml(statusUrl)}">Full status</a></p>`,
    promo.html || '',
    `</div>`,
  ].join('');

  return {
    to: params.to,
    subject,
    text: lines.join('\n') + (promo.text ? `\n\n${promo.text}` : ''),
    html,
  };
}

/**
 * Parse a JSON text column, falling back when it is empty or broken.
 *
 * @template T
 * @param {unknown} raw
 * @param {T} fallback
 * @returns {T}
 */
function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    const value = JSON.parse(String(raw));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Everything one submission's notice says, read from the ledger and the feeds.
 *
 * @param {import('@rssamplifier/db/src/pg.js').PgClient} db
 * @param {any} row a row from submissionsAwaitingNotice
 * @returns {Promise<{ added: number, listed: number, failed: number, feeds: NoticeFeed[] }>}
 */
export async function submissionNoticeData(db, row) {
  const id = String(row.id);
  const progress = await q.submissionProgress(db, id);

  /** @type {Array<{ slug: string, path?: string|null, existing?: boolean }>} */
  const inline = parseJson(row.accepted, []);
  /** @type {Array<{ url?: string, error?: string }>} */
  const rejected = parseJson(row.errors, []);

  // Inline feeds are not stamped with the submission id (a new one is written
  // by submitOne, an existing one belongs to whoever added it first), so they
  // are looked up by slug. Queued ones are found by id.
  const known = new Map((await q.feedsBySlugs(db, inline.map((a) => a.slug))).map((f) => [String(f.slug), f]));
  const queued = await q.submissionNoticeFeeds(db, id);

  /** @type {NoticeFeed[]} */
  const feeds = [];
  for (const a of inline) {
    const f = known.get(String(a.slug));
    feeds.push({ slug: a.slug, path: a.path ?? null, title: f?.title ?? null, outcome: a.existing ? 'listed' : 'added' });
  }
  for (const f of queued) {
    const status = String(f.status);
    feeds.push({
      slug: String(f.slug),
      title: f.title ?? null,
      outcome: status === 'active' ? 'added' : status === 'pending' ? 'waiting' : 'failed',
      reason: status === 'active' || status === 'pending' ? null : (f.last_error ?? status),
    });
  }
  for (const r of rejected) {
    feeds.push({ url: r.url || null, outcome: 'failed', reason: r.error ?? null });
  }

  const inlineAdded = inline.filter((a) => !a.existing).length;
  const inlineListed = inline.length - inlineAdded;

  return {
    added: inlineAdded + progress.crawled,
    listed: inlineListed + Math.max(0, Number(row.already_listed ?? 0) || 0),
    failed: progress.failed + Math.max(rejected.length, Number(row.rejected_count ?? 0) || 0),
    // Failures last: the note leads with what worked.
    feeds: feeds.sort((a, b) => Number(a.outcome === 'failed') - Number(b.outcome === 'failed')).slice(0, 20),
  };
}

/**
 * Send one "your keyword search finished" note.
 *
 * @param {{ to: string, runId: string, keywords: string[], accepted: number, checked: number }} params
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendDiscoveryEmail(params) {
  return sendEmail(await discoveryEmail(params));
}

/**
 * The "your keyword search finished" message, built but not sent.
 *
 * @param {{ to: string, runId: string, keywords: string[], accepted: number, checked: number }} params
 * @returns {Promise<{ to: string, subject: string, text: string }>}
 */
export async function discoveryEmail(params) {
  const site = siteUrl();
  const statusUrl = `${site}/discoveries/${params.runId}`;
  const shown = params.keywords.slice(0, 5).join(', ');
  const more = params.keywords.length > 5 ? ` and ${params.keywords.length - 5} more` : '';

  const lines = [
    `Your keyword search on RSSAmp has finished.`,
    ``,
    `  Keywords:     ${shown}${more}`,
    `  Sites checked: ${params.checked}`,
    `  Blogs added:   ${params.accepted}`,
    ``,
    `Full status: ${statusUrl}`,
  ];

  return {
    to: params.to,
    subject: `${params.accepted} new blogs from your keyword search`,
    text: lines.join('\n') + (await promoText(params.to)),
  };
}

/**
 * Notify every discovery run whose candidate queue has drained, once each.
 *
 * Same one-attempt rule as submissions: marked notified whether or not the
 * send worked, so a bouncing address is not retried every tick forever.
 *
 * @param {import('@rssamplifier/db/src/pg.js').PgClient} db
 * @param {number} [limit]
 * @returns {Promise<{ sent: number, failed: number }>}
 */
export async function notifyFinishedDiscoveries(db, limit = 5) {
  if (!emailEnabled()) return { sent: 0, failed: 0 };

  const due = await discovery.runsAwaitingNotice(db, limit);
  let sent = 0;
  let failed = 0;

  for (const row of due) {
    const id = String(row.id);
    const progress = await discovery.runProgress(db, id);

    let keywords = [];
    try {
      keywords = JSON.parse(String(row.keywords ?? '[]'));
    } catch {
      keywords = [];
    }

    const res = await sendDiscoveryEmail({
      to: String(row.notify_email),
      runId: id,
      keywords,
      accepted: progress.accepted,
      checked: progress.total - progress.waiting,
    });

    await discovery.markRunNotified(db, id);
    if (res.ok) sent += 1;
    else failed += 1;
  }

  return { sent, failed };
}

/**
 * Notify every submission whose queue has drained, once each.
 *
 * The row is claimed (notified_at set) before the send, not after it. A poller
 * restarted between a send and its mark would otherwise mail the same person
 * again, and a transient provider failure retried every tick would mail a
 * bouncing address every minute forever. One attempt and a logged failure is
 * the friendlier trade.
 *
 * @param {import('@rssamplifier/db/src/pg.js').PgClient} db
 * @param {number} [limit]
 * @param {{ send?: typeof sendSubmissionEmail, log?: (event: string, data: object) => void }} [deps]
 * @returns {Promise<{ sent: number, failed: number }>}
 */
export async function notifyFinishedSubmissions(db, limit = 5, deps = {}) {
  const send = deps.send ?? sendSubmissionEmail;
  if (!deps.send && !emailEnabled()) return { sent: 0, failed: 0 };

  const due = await q.submissionsAwaitingNotice(db, limit);
  let sent = 0;
  let failed = 0;

  for (const row of due) {
    const id = String(row.id);
    if (!(await q.claimSubmissionNotice(db, id))) continue;

    let res;
    try {
      const data = await submissionNoticeData(db, row);
      res = await send({ to: String(row.notify_email), submissionId: id, ...data });
      deps.log?.('submission-notice', {
        submission: id,
        ok: res.ok,
        added: data.added,
        listed: data.listed,
        failed: data.failed,
        ...(res.id ? { messageId: res.id } : {}),
        ...(res.error ? { error: String(res.error).slice(0, 200) } : {}),
      });
    } catch (err) {
      res = { ok: false, error: String(err?.message ?? err) };
      deps.log?.('submission-notice', { submission: id, ok: false, error: res.error.slice(0, 200) });
    }

    if (res.ok) sent += 1;
    else failed += 1;
  }

  return { sent, failed };
}
