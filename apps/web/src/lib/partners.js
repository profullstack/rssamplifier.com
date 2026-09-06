import { SESSION_COOKIE, resolveSession } from '@rssamplifier/auth';
import { createPartners, sqlStore } from '@profullstack/partners';

import { db, siteUrl } from './db.js';

/**
 * The seller side of the directory.
 *
 * Every blog here belongs to somebody else, and traffic_hourly says most of
 * what reads them is machines. crawl_sales says what those machines paid.
 * This is how the publishers get their share: prove you own the site behind
 * a feed we already index, say which topics you write about, and take a cut.
 *
 * The module owns none of the auth. It asks who is here and we answer from
 * the same session cookie the rest of the site uses.
 */

const execute = async ({ sql, args = [] }) => db().execute({ sql, args });
const store = sqlStore({ execute });

/** The session cookie off a bare Request; the module hands us one, not a Next context. */
function cookieToken(request) {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

async function currentUser(request) {
  const token = cookieToken(request);
  if (!token) return null;
  try {
    const user = await resolveSession(db(), token);
    return user ? { id: String(user.id), name: user.name ?? user.email ?? null, email: user.email ?? null } : null;
  } catch {
    // A database hiccup degrades to "signed out" rather than a 500 on a page
    // whose whole job is to explain the programme.
    return null;
  }
}

/**
 * ISO 639-1 codes, which are not subjects.
 *
 * Topics come from publishers' own <category> tags, and a great many feeds tag
 * themselves with their language. Ordered by feed count those float straight to
 * the top, so the first thing a publisher saw on the sign-up form was a row of
 * checkboxes reading "de", "en", "la". Two-letter subjects that are real, "ai"
 * most of all, have to survive, so this excludes the language codes by name
 * rather than excluding short slugs by length.
 */
const LANGUAGE_CODES = new Set([
  'aa','ab','ae','af','ak','am','an','ar','as','av','ay','az','ba','be','bg','bh','bi','bm','bn','bo','br','bs',
  'ca','ce','ch','co','cr','cs','cu','cv','cy','da','de','dv','dz','ee','el','en','eo','es','et','eu','fa','ff',
  'fi','fj','fo','fr','fy','ga','gd','gl','gn','gu','gv','ha','he','hi','ho','hr','ht','hu','hy','hz','ia','id',
  'ie','ig','ii','ik','io','is','it','iu','ja','jv','ka','kg','ki','kj','kk','kl','km','kn','ko','kr','ks','ku',
  'kv','kw','ky','la','lb','lg','li','ln','lo','lt','lu','lv','mg','mh','mi','mk','ml','mn','mr','ms','mt','my','na',
  'nb','nd','ne','ng','nl','nn','no','nr','nv','ny','oc','oj','om','or','os','pa','pi','pl','ps','pt','qu','rm',
  'rn','ro','ru','rw','sa','sc','sd','se','sg','si','sk','sl','sm','sn','so','sq','sr','ss','st','su','sv','sw',
  'ta','te','tg','th','ti','tk','tl','tn','to','tr','ts','tt','tw','ty','ug','uk','ur','uz','ve','vi','vo','wa',
  'wo','xh','yi','yo','za','zh','zu',
]);

/**
 * The niches a partner may claim: the directory's own topics, busiest first,
 * minus the language tags. Resolved per request, so a topic that appeared this
 * week is claimable this week. Capped, because the full list is thousands long
 * and a checkbox for each is not a form anybody fills in.
 */
async function niches() {
  const { rows } = await db().execute({
    sql: 'select slug from topics where feed_count >= 2 order by feed_count desc, slug limit 80',
    args: [],
  });
  return rows
    .map((r) => String(r.slug))
    .filter((slug) => !LANGUAGE_CODES.has(slug))
    .slice(0, 40);
}

/** @type {ReturnType<typeof createPartners> | null} */
let program = null;

/**
 * Built lazily and only when the secret exists.
 *
 * The module refuses to construct without one, and it is right to: a
 * guessable verification token pays the wrong person for someone else's
 * writing. That refusal must not take the site down on a deploy where the
 * variable was forgotten, so /sell simply does not exist until it is set.
 */
export function partners() {
  if (program) return program;
  const secret = process.env['PARTNER_VERIFY_SECRET'];
  if (!secret) return null;
  program = createPartners({
    siteName: 'RSS Amplifier',
    siteUrl: siteUrl(),
    basePath: '/sell',
    store,
    secret,
    loginUrl: '/signin?next=/sell',
    currentUser,
    niches,
  });
  return program;
}

/**
 * Split one crawl sale across the publishers whose blogs were in the crawl.
 *
 * Attribution belongs here because only this side knows whose feeds are in
 * the index. A verified domain is matched against the host of each feed's
 * site_url, and the sale is shared pro-rata by how many items that publisher
 * has contributed, each at their own rate.
 *
 * The credit ref carries the partner id, so a settlement delivered twice pays
 * once. Never allowed to fail the sale: the money has already moved.
 */
export async function splitSale(sale) {
  const p = partners();
  if (!p || !sale?.ref || !Number(sale.totalCents)) return 0;

  const { rows } = await db().execute({
    sql: `select pp.partner_id as partner_id, count(fi.id) as items
          from partner_properties pp
          join feeds f
            on f.site_url is not null
           and (
             lower(replace(replace(replace(f.site_url, 'https://', ''), 'http://', ''), 'www.', '')) = pp.domain
             or lower(replace(replace(replace(f.site_url, 'https://', ''), 'http://', ''), 'www.', '')) like pp.domain || '/%'
           )
          join feed_items fi on fi.feed_id = f.id
          where pp.verified_at is not null
          group by pp.partner_id
          having count(fi.id) > 0`,
    args: [],
  });
  if (!rows.length) return 0;

  const total = rows.reduce((n, r) => n + Number(r.items), 0);
  let paid = 0;
  for (const row of rows) {
    const partnerId = String(row.partner_id);
    const partner = await store.getPartnerById(partnerId);
    if (!partner) continue;
    const properties = await store.listProperties(partnerId);
    const rate = p.rateFor(partner, properties);
    const share = Math.floor((Number(sale.totalCents) * (Number(row.items) / total) * rate) / 100);
    if (share <= 0) continue;
    if (await p.credit({ partnerId, cents: share, ref: `${sale.ref}:${partnerId}` })) paid += share;
  }
  return paid;
}
