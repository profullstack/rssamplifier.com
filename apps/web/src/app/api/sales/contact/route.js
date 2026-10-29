import { salesContact } from '../../../../lib/salesContact.js';

export const dynamic = 'force-dynamic';

/**
 * The only way into a corpus conversation: checks, stores, then notifies.
 * The why of all three is in lib/salesContact.js. A plain form post gets a 303
 * back to /sales#enquire (?sent=1 or ?error=...); a JSON caller gets
 * { ok: true } or { ok: false, error }.
 */
export const POST = salesContact.POST;
