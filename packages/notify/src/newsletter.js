import { newsletter } from '@rssamplifier/db';
import { sendEmail, emailEnabled } from '@rssamplifier/mail';

import { siteOrigin, trim } from './render.js';

/**
 * The weekly digest: what it says, when it goes, and the pass that sends it.
 *
 * Runs in the poller on a short timer and does nothing outside its slot, so
 * "weekly" is a fact about the clock rather than about when the process last
 * restarted. The rules, in the order they matter:
 *
 *   1. **One issue per week.** The week's mail is built once and stored; every
 *      reader of a week gets the same text, and the web copy is the mail.
 *   2. **Claim before sending.** A reader's row for the week is written first,
 *      so a crash or a deploy mid-batch costs that reader one digest and never
 *      sends anybody a second copy.
 *   3. **Never a late surprise.** A week that has not started by the end of its
 *      window is skipped, not sent on Wednesday because the poller came back
 *      then. A week already under way finishes whenever it can.
 *   4. **Nothing to say, nothing sent.** An issue with every section empty is
 *      not mailed.
 */

/** Monday, 15:00 UTC: morning in the Americas, afternoon in Europe. */
export const DEFAULT_SLOT = { day: 1, hour: 15 };

/** Hours after the slot in which a week may still start. */
export const DEFAULT_WINDOW_HOURS = 24;

/** Readers mailed per pass, and the gap between two sends. */
export const DEFAULT_BATCH = 100;
export const SEND_GAP_MS = 600;

/** Stands in for each reader's own unsubscribe link inside a stored issue. */
export const UNSUBSCRIBE_SLOT = '{{unsubscribe_url}}';

const DAY_MS = 86_400_000;
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * The ISO week a moment falls in: '2026-W44'.
 *
 * @param {Date} date
 * @returns {string}
 */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * The slot from `NEWSLETTER_SLOT` ("MON 15:00", UTC), or the default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ day: number, hour: number }}
 */
export function slotConfig(env = process.env) {
  const m = /^\s*([a-z]{3})\w*\s+(\d{1,2})(?::00)?\s*$/i.exec(String(env['NEWSLETTER_SLOT'] ?? ''));
  if (!m) return DEFAULT_SLOT;
  const day = DAYS.indexOf(m[1].toUpperCase());
  const hour = Number(m[2]);
  if (day < 0 || hour > 23) return DEFAULT_SLOT;
  return { day, hour };
}

/**
 * This week's slot (the ISO week of `now`, Monday to Sunday).
 *
 * @param {Date} now
 * @param {{ day: number, hour: number }} [slot]
 * @returns {Date}
 */
export function slotOfWeek(now, slot = DEFAULT_SLOT) {
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const offset = (slot.day + 6) % 7;
  return new Date(monday.getTime() + offset * DAY_MS + slot.hour * 3_600_000);
}

/**
 * The next slot strictly after `now`.
 *
 * @param {Date} now
 * @param {{ day: number, hour: number }} [slot]
 * @returns {Date}
 */
export function nextSlot(now, slot = DEFAULT_SLOT) {
  const here = slotOfWeek(now, slot);
  return here.getTime() > now.getTime() ? here : new Date(here.getTime() + 7 * DAY_MS);
}

/**
 * The link in a reader's mail that takes them off the list in one click.
 *
 * @param {string} origin
 * @param {string} userId
 * @param {string} token
 * @returns {string}
 */
export function unsubscribeUrl(origin, userId, token) {
  return `${origin}/newsletter/unsubscribe?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}`;
}

/**
 * The headers a mailbox draws its own unsubscribe button from (RFC 2369 and
 * the one-click POST of RFC 8058).
 *
 * @param {string} url
 * @returns {Record<string, string>}
 */
export function listHeaders(url) {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * Build a week's issue from what digestData read.
 *
 * Returns null when every section is empty.
 *
 * @param {Awaited<ReturnType<typeof newsletter.digestData>>} data
 * @param {{ week: string, origin?: string }} opts
 * @returns {{ week: string, subject: string, text: string, html: string, data: object }|null}
 */
export function renderIssue(data, { week, origin = siteOrigin() }) {
  /** @type {Array<{ title: string, intro?: string, items: Array<{ title: string, url: string, note?: string }> }>} */
  const sections = [];

  if (data.newFeeds.length) {
    sections.push({
      title: 'New in the directory',
      intro: `${data.newFeedCount.toLocaleString('en-US')} feeds joined this week. A few that published straight away:`,
      items: data.newFeeds.map((f) => ({
        title: String(f.title),
        url: `${origin}/${encodeURIComponent(String(f.slug))}`,
        note: f.description ? trim(String(f.description), 140) : undefined,
      })),
    });
  }

  if (data.followed.length) {
    sections.push({
      title: 'From the most-followed blogs',
      items: data.followed.map((p) => ({
        title: String(p.title || 'Untitled'),
        url: String(p.url || `${origin}/${encodeURIComponent(String(p.feed_slug))}`),
        note: String(p.feed_title),
      })),
    });
  }

  if (data.liked.length) {
    sections.push({
      title: 'What readers liked',
      items: data.liked.map((p) => ({
        title: String(p.title || 'Untitled'),
        url: String(p.url || `${origin}/${encodeURIComponent(String(p.feed_slug))}`),
        note: String(p.feed_title),
      })),
    });
  }

  if (data.rings.length || data.joined.length) {
    sections.push({
      title: 'Webrings',
      intro: data.rings.length
        ? `The rings people browsed most: ${data.rings.map((r) => r.title).join(', ')}.`
        : undefined,
      items: [
        ...data.joined.map((m) => ({
          title: String(m.title),
          url: String(m.site_url),
          note: `joined ${m.ring_title}`,
        })),
        ...data.rings.map((r) => ({
          title: `${r.title} ring`,
          url: `${origin}/ring/${encodeURIComponent(String(r.slug))}`,
        })),
      ],
    });
  }

  if (!sections.length) return null;

  const subject = data.newFeedCount
    ? `RSS Amplifier this week: ${data.newFeedCount.toLocaleString('en-US')} new feeds`
    : 'RSS Amplifier this week';

  const footerText = [
    'You get this because your RSS Amplifier account is on the weekly digest.',
    `Unsubscribe in one click: ${UNSUBSCRIBE_SLOT}`,
    `Settings: ${origin}/account`,
  ];

  const text = [
    `RSS Amplifier, week ${week}`,
    '',
    ...sections.flatMap((s) => [
      s.title.toUpperCase(),
      ...(s.intro ? [s.intro] : []),
      ...s.items.map((i) => `- ${i.title}${i.note ? ` (${i.note})` : ''}\n  ${i.url}`),
      '',
    ]),
    `Your follows, all in one place: ${origin}/following`,
    '',
    ...footerText,
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f7f6f2;padding:28px 14px;font:16px/1.55 Georgia,'Times New Roman',serif;color:#1d1c1a">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e0d6;border-radius:12px;padding:26px">
<p style="margin:0 0 4px;font:700 19px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">RSS Amplifier</p>
<p style="margin:0 0 22px;color:#6d6a61;font-size:14px">The week of ${esc(week)}</p>
${sections
  .map(
    (s) => `<h2 style="margin:22px 0 8px;font:700 16px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">${esc(s.title)}</h2>
${s.intro ? `<p style="margin:0 0 8px">${esc(s.intro)}</p>` : ''}<ul style="margin:0;padding-left:20px">
${s.items
  .map(
    (i) =>
      `<li style="margin:0 0 8px"><a href="${esc(i.url)}" style="color:#1f5fa8">${esc(i.title)}</a>${i.note ? `<br><span style="color:#6d6a61;font-size:14px">${esc(i.note)}</span>` : ''}</li>`,
  )
  .join('\n')}
</ul>`,
  )
  .join('\n')}
<p style="margin:24px 0 0"><a href="${esc(origin)}/following" style="color:#1f5fa8">Your follows, all in one place</a></p>
<hr style="border:0;border-top:1px solid #e3e0d6;margin:24px 0 14px">
<p style="margin:0;color:#6d6a61;font-size:13px">You get this because your RSS Amplifier account is on the weekly digest.
<a href="${UNSUBSCRIBE_SLOT}" style="color:#6d6a61">Unsubscribe in one click</a> &middot; <a href="${esc(origin)}/account" style="color:#6d6a61">Settings</a></p>
</div></body></html>`;

  return { week, subject, text, html, data };
}

/**
 * Put one reader's own link into a stored issue.
 *
 * @param {{ text: string, html: string }} issue
 * @param {string} url
 */
export function personalize(issue, url) {
  return {
    text: issue.text.split(UNSUBSCRIBE_SLOT).join(url),
    html: issue.html.split(UNSUBSCRIBE_SLOT).join(esc(url)),
  };
}

/**
 * One pass of the weekly send.
 *
 * `dryRun` reads everything and writes nothing: no issue is stored, nobody is
 * claimed, nothing is mailed. It reports who would be mailed and what.
 *
 * @param {import('@libsql/client').Client} db
 * @param {{
 *   now?: Date,
 *   dryRun?: boolean,
 *   force?: boolean,
 *   limit?: number,
 *   gapMs?: number,
 *   env?: NodeJS.ProcessEnv,
 *   transport?: { send: (m: object) => Promise<{ ok: boolean, error?: string }>, enabled: () => boolean },
 *   sleep?: (ms: number) => Promise<void>,
 * }} [opts]
 */
export async function runNewsletter(db, opts = {}) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const origin = siteOrigin(env);
  const slot = slotConfig(env);
  const windowHours = Number(env['NEWSLETTER_WINDOW_HOURS']) || DEFAULT_WINDOW_HOURS;
  const limit = opts.limit ?? (Number(env['NEWSLETTER_BATCH']) || DEFAULT_BATCH);
  const gapMs = opts.gapMs ?? SEND_GAP_MS;
  const transport = opts.transport ?? { send: sendEmail, enabled: emailEnabled };
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const dryRun = Boolean(opts.dryRun);

  const week = isoWeek(now);
  const at = slotOfWeek(now, slot);
  const base = { week, slot: at.toISOString(), next: nextSlot(now, slot).toISOString(), dryRun };

  if (!opts.force && now.getTime() < at.getTime()) return { ...base, status: 'waiting' };

  let issue = await newsletter.issueFor(db, week);
  if (!issue) {
    if (!opts.force && now.getTime() > at.getTime() + windowHours * 3_600_000) {
      return { ...base, status: 'missed-window' };
    }
    const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    const built = renderIssue(await newsletter.digestData(db, { since }), { week, origin });
    if (!built) return { ...base, status: 'nothing-to-say' };
    if (dryRun) {
      const size = await newsletter.listSize(db);
      return { ...base, status: 'dry-run', recipients: size.subscribers, subject: built.subject, text: built.text };
    }
    issue = await newsletter.saveIssue(db, built);
  } else if (issue.finished_at) {
    return { ...base, status: 'sent', sent: issue.sent_count };
  }

  if (dryRun) {
    const pending = await newsletter.pendingFor(db, week, 100_000);
    return { ...base, status: 'dry-run', recipients: pending.length, subject: issue.subject, text: issue.text };
  }

  const off = ['0', 'false', 'off'].includes(String(env['NEWSLETTER_SEND'] ?? '').toLowerCase());
  if (off) return { ...base, status: 'disabled' };
  if (!transport.enabled()) return { ...base, status: 'email-not-configured' };

  const batch = await newsletter.pendingFor(db, week, limit);
  let sent = 0;
  let failed = 0;
  for (const reader of batch) {
    if (!(await newsletter.claimSend(db, week, reader.id))) continue;
    const url = unsubscribeUrl(origin, reader.id, await newsletter.tokenFor(db, reader.id));
    const body = personalize(issue, url);
    const outcome = await transport.send({
      to: reader.email,
      subject: issue.subject,
      text: body.text,
      html: body.html,
      headers: listHeaders(url),
    });
    await newsletter.finishSend(db, week, reader.id, outcome);
    if (outcome.ok) sent += 1;
    else failed += 1;
    if (gapMs > 0) await sleep(gapMs);
  }

  const done = batch.length < limit;
  await newsletter.closeIssue(db, week, done);
  return { ...base, status: done ? 'finished' : 'sending', sent, failed };
}

/** @param {unknown} s */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
