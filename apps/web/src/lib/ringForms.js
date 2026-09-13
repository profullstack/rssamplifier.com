import { webrings } from '@rssamplifier/db';

/** Slugs that are pages under /ring, so a ring cannot take them. */
const RESERVED = new Set([
  'new', 'edit', 'next', 'previous', 'prev', 'random', 'opml', 'check', 'view', 'leaders', 'like', 'share',
]);

/**
 * The fields of the make-a-ring and edit-a-ring forms, from a form post or
 * a JSON body. Null when the body cannot be read at all.
 *
 * `members` is one entry per line (or an array in JSON): a site address, a
 * feed address, or a directory slug.
 *
 * @param {Request} req
 * @returns {Promise<{ title: string, description: string|null, members: string[] }|null>}
 */
export async function readRingForm(req) {
  /** @type {any} */
  let body;
  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      body = await req.json();
    } else {
      const form = await req.formData();
      body = Object.fromEntries(form.entries());
    }
  } catch {
    return null;
  }
  const title = String(body?.title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const descriptionRaw = String(body?.description ?? '').trim().slice(0, 500);
  const members = Array.isArray(body?.members)
    ? body.members.map(String)
    : String(body?.members ?? '')
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
  return { title, description: descriptionRaw || null, members: members.slice(0, 200) };
}

/**
 * Which of the entries are feeds in the directory, in the order given, and
 * which are not.
 *
 * @param {import('@rssamplifier/db').Client} db
 * @param {string[]} entries
 * @returns {Promise<{ found: Array<{ id: string, slug: string, site_url: string, title: string }>, missing: string[] }>}
 */
export async function resolveMembers(db, entries) {
  const found = [];
  const missing = [];
  const seen = new Set();
  for (const entry of entries) {
    const feed = await webrings.feedForRingInput(db, entry);
    if (!feed || !feed.site_url) {
      missing.push(entry);
      continue;
    }
    if (seen.has(feed.id)) continue;
    seen.add(feed.id);
    found.push(feed);
  }
  return { found, missing };
}

/**
 * A slug for a new ring from its title: lower case, dashes, at most sixty
 * characters, and not one that is already a ring, a topic (every topic is a
 * ring) or a page under /ring. Numbered when taken.
 *
 * @param {import('@rssamplifier/db').Client} db
 * @param {string} title
 * @returns {Promise<string>}
 */
export async function ringSlugFor(db, title) {
  const base =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'ring';
  for (let n = 1; n < 50; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (RESERVED.has(slug)) continue;
    if (await webrings.ringBySlug(db, slug)) continue;
    if (await webrings.topicRingPreview(db, slug, { limit: 1 })) continue;
    return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}
