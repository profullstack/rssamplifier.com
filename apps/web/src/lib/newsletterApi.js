import { newsletter } from '@rssamplifier/db';
import { isoWeek, nextSlot, renderIssue, slotConfig, UNSUBSCRIBE_SLOT } from '@rssamplifier/notify';

import { db, siteUrl } from './db.js';

/**
 * What the newsletter API, page, CLI and MCP all say about the digest: when it
 * goes, how many are on it, and the latest issue.
 *
 * @returns {Promise<object>}
 */
export async function newsletterStatus() {
  const client = db();
  const now = new Date();
  const slot = slotConfig();
  const [latest, size] = await Promise.all([newsletter.latestIssue(client), newsletter.listSize(client)]);
  return {
    name: 'RSS Amplifier weekly digest',
    schedule: { every: 'week', day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][slot.day], hourUtc: slot.hour },
    nextSend: nextSlot(now, slot).toISOString(),
    thisWeek: isoWeek(now),
    subscribers: size.subscribers,
    defaultOptIn: true,
    latest: latest ? publicIssue(latest) : null,
    page: `${siteUrl()}/newsletter`,
  };
}

/**
 * This week's issue as it would be built now. Read-only: nothing is stored.
 *
 * @returns {Promise<object|null>}
 */
export async function newsletterPreview() {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const week = isoWeek(now);
  const built = renderIssue(await newsletter.digestData(db(), { since }), { week, origin: siteUrl() });
  return built ? publicIssue({ ...built, created_at: null, finished_at: null, sent_count: 0 }) : null;
}

/**
 * An issue with nobody's unsubscribe link in it.
 *
 * @param {{ week: string, subject: string, text: string, html: string, created_at: string|null, finished_at: string|null, sent_count: number }} issue
 */
export function publicIssue(issue) {
  const settings = `${siteUrl()}/account#newsletter`;
  return {
    week: issue.week,
    subject: issue.subject,
    text: issue.text.split(UNSUBSCRIBE_SLOT).join(settings),
    html: issue.html.split(UNSUBSCRIBE_SLOT).join(settings),
    builtAt: issue.created_at,
    finishedAt: issue.finished_at,
    sent: issue.sent_count,
  };
}

/**
 * @param {unknown} body
 * @param {number} [status]
 */
export function noStoreJson(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
