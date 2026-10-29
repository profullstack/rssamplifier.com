import { createContactForm } from '@profullstack/contact-form';
import { clientIp } from '@profullstack/x402-gateway/edge';
import { dataset } from '@rssamplifier/db';
import { hashIp } from '@rssamplifier/ingest';
import { sendEmail } from '@rssamplifier/mail';

import { db } from './db.js';

/**
 * The corpus enquiry form on /sales, and its handler at /api/sales/contact.
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
 * So the spam is paid for rather than avoided: @profullstack/contact-form's
 * proof-of-render token and honeypot, and a per-address limit kept in the
 * database.
 *
 * ## Why it is written down before it is sent
 *
 * Mail here is best-effort. That is right for a sign-in link, which the reader
 * can simply request again — it is wrong for a sales enquiry, which the sender
 * believes is delivered and will never send twice. So the row lands first
 * (`persist`), the notification goes on top of it, and a Resend outage costs a
 * notification rather than a customer (`onSendError: 'ignore'`).
 *
 * Built by a factory so the tests can hand it a store and a transport; the
 * site uses `salesContact` below.
 */

/** How long the flood window is. */
export const WINDOW_MS = 60 * 60 * 1000;

/**
 * Enquiries one address may send in that window.
 *
 * Three, not one. A genuine sender who mistypes their own email address and
 * resends is the most likely repeat here, and refusing them is worse than
 * accepting a third message from a spammer we are also storing and rate
 * limiting.
 */
export const MAX_PER_WINDOW = 3;

export const TOO_MANY =
  'That is several enquiries in an hour. Email hello@rssamplifier.com directly and we will pick it up there.';
export const NO_USE_CASE =
  'Please say what you want the corpus for — it is the field that decides what we can offer.';

/** The address a request comes from, the way every other limit on this site reads it. */
const ipOf = (req) => clientIp({ headers: req.headers }) || null;
const ipHashOf = (ip) => hashIp(ip, process.env['IP_HASH_SALT']);

/**
 * @param {{
 *   store?: { enquiryCountFrom: Function, insertEnquiry: Function },
 *   client?: () => unknown,
 *   send?: typeof sendEmail,
 *   guard?: object | false,
 * }} [deps]
 */
export function makeSalesContact(deps = {}) {
  const store = deps.store ?? dataset;
  const client = deps.client ?? db;
  const send = deps.send ?? sendEmail;

  return createContactForm({
    binding: 'rssamplifier:sales',
    brandTerms: ['rss amplifier', 'rssamplifier'],
    // Read through a non-literal property access: Next inlines `process.env.FOO`
    // at build time.
    to: process.env['SALES_EMAIL'] || 'hello@rssamplifier.com',
    action: '/api/sales/contact',
    // A plain form post (JavaScript off) comes back to the form's anchor.
    redirect: '/sales#enquire',
    guard: deps.guard ?? { rateLimit: { max: MAX_PER_WINDOW, windowMs: WINDOW_MS } },
    ip: ipOf,
    style: 'ok',
    questions: [
      { name: 'intro', type: 'section', label: 'Only the email and the last box are required' },
      { name: 'name', label: 'Your name', placeholder: 'Your name', maxLength: 120, autocomplete: 'name' },
      {
        name: 'email',
        type: 'email',
        label: 'Your email address',
        placeholder: 'you@example.com',
        maxLength: 200,
        required: true,
        autocomplete: 'email',
      },
      {
        name: 'org',
        label: 'Company or project',
        placeholder: 'Company or project',
        maxLength: 160,
        autocomplete: 'organization',
      },
      {
        // `use_case` is the name that reads correctly in HTML; a JSON caller may
        // send `useCase` (see mapBody).
        name: 'use_case',
        type: 'textarea',
        label: 'What do you want the corpus for?',
        placeholder:
          'What do you want the corpus for?\n\nWhich streams you need, roughly what scale, how often you would pull, and what it is being used to build.',
        rows: 5,
        maxLength: 4000,
        required: true,
        pattern: '^[\\s\\S]{10,}$',
        patternMessage: NO_USE_CASE,
        help: 'The last box is the one that decides what we can offer, so it is the one worth writing. Rough is fine; vague costs us both a round trip.',
      },
    ],
    messageField: 'use_case',
    mapBody: (body) => ({ ...body, use_case: body.use_case ?? body.useCase }),
    // The database keeps the limit across restarts and instances.
    verify: async (_body, req) => {
      const since = new Date(Date.now() - WINDOW_MS).toISOString();
      const recent = await store.enquiryCountFrom(client(), ipHashOf(ipOf(req)), since);
      return recent >= MAX_PER_WINDOW ? TOO_MANY : true;
    },
    persist: async (s, verdict) => {
      const v = s.values ?? {};
      await store.insertEnquiry(client(), {
        name: v.name || null,
        email: v.email.toLowerCase(),
        org: v.org || null,
        useCase: v.use_case,
        ipHash: ipHashOf(verdict?.ip ?? null),
        userAgent: verdict?.userAgent?.slice(0, 300) ?? null,
      });
      return undefined;
    },
    subject: (s) => `Corpus enquiry: ${s.values?.org || s.email}`,
    send: async (mail) => {
      const r = await send({
        to: mail.to,
        subject: mail.subject,
        text: `${mail.text ?? ''}\n\nStored in dataset_enquiries. Grant access with an insert into dataset_grants.`,
        html: mail.html,
        replyTo: mail.replyTo?.toLowerCase(),
      });
      return { sent: r.ok, error: r.error };
    },
    onSendError: 'ignore',
    submitLabel: 'Send enquiry',
    successMessage:
      'Thank you — that is recorded and someone will reply to the address you gave.',
    responses: {
      limited: { body: { ok: false, error: TOO_MANY }, status: 429 },
    },
  });
}

export const salesContact = makeSalesContact();

/**
 * Every message a plain form post (JavaScript off) can be sent back to /sales
 * with in `?error=`. The page shows one of these or a generic line, never
 * whatever text a link happens to carry.
 */
export function formErrors(form = salesContact) {
  const out = new Set([
    TOO_MANY,
    'That took too long. Please send it again.',
    'Too many messages. Please try again later.',
    'Invalid submission',
  ]);
  for (const q of form.questions) {
    if (q.type === 'section') continue;
    out.add(`${q.label} is required`);
    out.add(`${q.label} is too long (${q.maxLength} characters at most)`);
    if (q.type === 'email') out.add(`${q.label} must be a valid email address`);
    if (q.patternMessage) out.add(q.patternMessage);
  }
  return out;
}
