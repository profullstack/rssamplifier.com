import { dataset } from '@rssamplifier/db';
import { sendEmail, emailEnabled } from '@rssamplifier/mail';

import { db } from '../../../../lib/db.js';
import { requestMeta } from '../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * The only way into a corpus conversation.
 *
 * ## Why a form here when /contact deliberately has none
 *
 * That page's comment says it plainly: "no form, because a form on a site with
 * no accounts is one more thing to spam", and it routes to published addresses
 * instead. The reasoning holds and this is not a reversal of it — it is a
 * different trade. /contact's job is to get a stranger to the right mailbox,
 * which a list of links does perfectly well. This page's job is to start a
 * negotiation, and the fields below (what they want it for, at what scale) are
 * exactly the ones that decide whether there is a deal and what it looks like.
 * An email that omits them costs a round trip; a form that asks for them does
 * not. So the spam is paid for rather than avoided, by the two guards below.
 *
 * ## Why it is written down before it is sent
 *
 * `sendEmail` reports a failure instead of throwing, and every caller in this
 * codebase treats mail as optional infrastructure. That is right for a sign-in
 * link, which the reader can simply request again — it is wrong for a sales
 * enquiry, which the sender believes is delivered and will never send twice. So
 * the row lands first, the mail is best-effort on top of it, and a Resend outage
 * costs a notification rather than a customer.
 */

/** How long the flood window is. */
const WINDOW_MS = 60 * 60 * 1000;

/**
 * Enquiries one address may send in that window.
 *
 * Three, not one. A genuine sender who mistypes their own email address and
 * resends is the most likely repeat here, and refusing them is worse than
 * accepting a third message from a spammer we are also storing and rate
 * limiting.
 */
const MAX_PER_WINDOW = 3;

/** Where an enquiry is announced, when mail is configured. */
const INBOX = process.env['SALES_EMAIL'] || 'hello@rssamplifier.com';

/**
 * @param {Request} req
 * @returns {Promise<Response>}
 */
export async function POST(req) {
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');
  const body = await readBody(req);
  if (!body) return respond(wantsHtml, 400, 'bad-request', 'That form could not be read.');

  // The honeypot. A field no human sees, no browser fills and every naive bot
  // completes. Answered with the same success the real path gives, because a
  // bot told it failed is a bot that tries again differently.
  if (body.website) {
    return respond(wantsHtml, 200, null, null);
  }

  const email = body.email.trim().toLowerCase();
  // Deliberately the weakest possible check. This address is going to be read by
  // a person who will reply to it, not authenticated — a strict pattern here
  // rejects the valid addresses nobody remembers are valid and gains nothing.
  if (!email || !email.includes('@') || email.length > 200) {
    return respond(wantsHtml, 400, 'bad-email', 'That does not look like an email address.');
  }

  const useCase = body.useCase.trim();
  if (useCase.length < 10) {
    return respond(
      wantsHtml,
      400,
      'no-use-case',
      'Please say what you want the corpus for — it is the field that decides what we can offer.',
    );
  }

  const client = db();
  const meta = await requestMeta();

  const recent = await dataset.enquiryCountFrom(
    client,
    meta.ipHash,
    new Date(Date.now() - WINDOW_MS).toISOString(),
  );
  if (recent >= MAX_PER_WINDOW) {
    return respond(
      wantsHtml,
      429,
      'too-many',
      'That is several enquiries in an hour. Email hello@rssamplifier.com directly and we will pick it up there.',
    );
  }

  await dataset.insertEnquiry(client, {
    name: body.name.trim().slice(0, 120) || null,
    email: email.slice(0, 200),
    org: body.org.trim().slice(0, 160) || null,
    useCase: useCase.slice(0, 4000),
    ipHash: meta.ipHash,
    userAgent: meta.userAgent,
  });

  if (emailEnabled()) {
    // Not awaited into the response. The enquiry is already stored, so the
    // sender's answer does not depend on Resend being reachable this second, and
    // making them wait on it would only ever make the form feel broken.
    void sendEmail({
      to: INBOX,
      subject: `Corpus enquiry: ${body.org.trim() || email}`,
      text: [
        `From:     ${body.name.trim() || '(no name)'} <${email}>`,
        `Company:  ${body.org.trim() || '(none given)'}`,
        '',
        'What for:',
        useCase.slice(0, 4000),
        '',
        // So a reply can be written without opening the database, and so the
        // operator knows the row exists even if this mail is the only thing they
        // ever see.
        'Stored in dataset_enquiries. Grant access with an insert into dataset_grants.',
      ].join('\n'),
      // Replying to the notification reaches the sender rather than ourselves,
      // which is the difference between a queue and an inbox.
      replyTo: email,
    }).catch(() => {});
  }

  return respond(wantsHtml, 200, null, null);
}

/**
 * HTML callers get a 303 back to the page; everyone else gets JSON.
 *
 * @param {boolean} wantsHtml
 * @param {number} status
 * @param {string|null} error
 * @param {string|null} detail
 * @returns {Response}
 */
function respond(wantsHtml, status, error, detail) {
  if (wantsHtml) {
    const to = error ? `/sales?error=${encodeURIComponent(error)}#enquire` : '/sales?sent=1#enquire';
    return new Response(null, { status: 303, headers: { location: to } });
  }

  return Response.json(error ? { error, detail } : { ok: true }, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

/**
 * Read a form or a JSON body into the same shape.
 *
 * @param {Request} req
 * @returns {Promise<{ name: string, email: string, org: string, useCase: string, website: string }|null>}
 */
async function readBody(req) {
  try {
    const source = (req.headers.get('content-type') ?? '').includes('application/json')
      ? await req.json()
      : Object.fromEntries(await req.formData());

    return {
      name: str(source?.name),
      email: str(source?.email),
      org: str(source?.org),
      // `useCase` for a JSON caller, `use_case` for the form field — the form
      // uses the name that reads correctly in HTML and the API uses the one that
      // reads correctly in JavaScript, and neither should have to know about the
      // other.
      useCase: str(source?.useCase) || str(source?.use_case),
      website: str(source?.website),
    };
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function str(value) {
  return value == null ? '' : String(value);
}
