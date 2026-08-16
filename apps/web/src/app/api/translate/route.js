import { q, translations } from '@rssamplifier/db';
import { ensureTranslation, normalizeLang } from '@rssamplifier/translate';

import { db } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';
import { popularLanguages } from '../../../lib/languages.js';

export const dynamic = 'force-dynamic';

/**
 * Read a post in another language.
 *
 * Accounts only, and this is the one control on the site where that is about
 * money rather than identity: a first translation is a paid API call, so it is
 * not something an anonymous request gets to trigger. Every post already
 * translated stays free to serve, and the reader page happily shows one to
 * anybody who has the row cached.
 *
 * Addressed by slug and guid rather than by the internal item id, like the rest
 * of the API — those two are the only handles the site publishes.
 *
 * The translation happens here rather than during the page render so the cost
 * and the wait land on the click that asked for it. By the time the 303 lands
 * back on the reader, the row is in the table and the page is a cache hit.
 *
 * @param {Request} req
 */
export async function POST(req) {
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html');

  let slug = '';
  let guid = '';
  let requested = '';

  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const body = await req.json();
      slug = String(body?.slug ?? '');
      guid = String(body?.guid ?? '');
      requested = String(body?.lang ?? '');
    } else {
      const form = await req.formData();
      slug = String(form.get('slug') ?? '');
      guid = String(form.get('guid') ?? '');
      requested = String(form.get('lang') ?? '');
    }
  } catch {
    return json({ error: 'bad-request' }, 400);
  }

  const back = `/${slug}/read?p=${encodeURIComponent(guid)}`;

  // An empty language is "show me the original" — a real choice, and the only
  // way back off a translation once one is set on the account.
  const lang = requested.trim() ? normalizeLang(requested) : null;
  if (requested.trim() && !lang) return json({ error: 'bad-language' }, 400);

  const user = await currentUser();
  if (!user) {
    const next = lang ? `${back}&lang=${lang}` : back;
    if (wantsHtml) return redirect(`/login?next=${encodeURIComponent(next)}`);
    return json({ error: 'sign-in-required' }, 401);
  }

  // Only languages the bar offers. Without this, a hand-written POST could walk
  // an arbitrary code list and bill a translation for each one.
  if (lang) {
    const offered = await popularLanguages();
    if (!offered.includes(lang)) return json({ error: 'unsupported-language' }, 400);
  }

  const client = db();
  const feed = await q.feedBySlug(client, slug);
  if (!feed) return wantsHtml ? redirect('/') : json({ error: 'not-found' }, 404);

  const item = await q.itemByGuid(client, String(feed.id), guid);
  if (!item) return wantsHtml ? redirect(`/${slug}`) : json({ error: 'not-found' }, 404);

  await translations.setReadingLanguage(client, String(user.id), lang);

  const attempt = lang
    ? await ensureTranslation(client, {
        itemId: String(item.id),
        title: String(item.title),
        summary: item.summary === null ? null : String(item.summary),
        targetLang: lang,
        sourceLang: feed.language === null ? null : String(feed.language),
        userId: String(user.id),
      })
    : { translation: null, limited: false };

  // The daily spend ceiling. To a browser this is not an error worth a page of
  // its own — the reader lands back on the post, which renders the original and
  // says why. An API caller gets the status that means "not now, try later",
  // because that is exactly what it means.
  if (wantsHtml) return redirect(lang ? `${back}&lang=${lang}` : back);
  if (attempt.limited) return json({ error: 'translation-limit-reached', slug, guid, lang }, 429);

  const result = attempt.translation;

  return json({
    ok: true,
    slug,
    guid,
    lang,
    // Null with a language asked for means "nothing to translate, or we could
    // not" — the reader sees the original either way, so it is not an error.
    translated: result
      ? { title: result.title, summary: result.summary, source_lang: result.sourceLang }
      : null,
  });
}

/**
 * @param {string} location
 * @returns {Response}
 */
function redirect(location) {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
