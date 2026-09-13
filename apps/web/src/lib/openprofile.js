import {
  applyOverrides,
  keyedSection,
  listSection,
  makeOpenProfile,
  mergeOverrides,
  overridesFromDocument,
  renderOpenProfile,
} from '@profullstack/openprofile';

/**
 * An author's OpenProfile.md (logicsrc.com/openprofile), built from what the
 * directory read off their own markup, corrected by what they told us.
 *
 * The generated file says only what the author published: their name, site
 * and avatar from an h-card or JSON-LD, the accounts they claimed with
 * rel="me", the subjects their feeds are filed under, and for every podcast or
 * show they publish, a Broadcast section (logicsrc.com/openbroadcast) with the
 * facts their own feed states. It never fills `Seeking`, `Pays`, `Charges` or a
 * Guest section: those are the person's to write, through the overlay, and
 * absent means unstated.
 *
 * `Since` is deliberately not written either. A feed is a window on a show,
 * the last fifty or hundred episodes, and the oldest item the directory holds
 * says when that window starts, not when the show did. A podcast running since
 * 2019 would read "Since: 2026-06", which is exactly the false claim the spec
 * forbids; the owner can write the year themselves.
 *
 * Email is deliberately not in the generated file even when the table has it.
 * The API republishes an address the author published; the profile is a
 * document other directories will copy, and the owner adds `Email` to it
 * themselves if they want it carried that far.
 */

/** Feed kinds that are a show, for which a Broadcast section is written. */
const BROADCAST_KINDS = new Map([
  ['podcast', 'podcast'],
  ['music', 'music'],
  ['video', 'video'],
  ['live', 'stream'],
]);

/** Most topics a profile lists; the union of its feeds' strongest. */
const MAX_TOPICS = 12;

/** Networks whose handle is the one a person would write on a slide. */
const HANDLE_NETWORKS = ['fediverse', 'bluesky', 'github', 'x', 'nostr', 'microblog'];

/**
 * What a network is called in a link label.
 *
 * @param {string} network
 * @returns {string}
 */
function label(network) {
  const names = {
    fediverse: 'Mastodon',
    bluesky: 'Bluesky',
    github: 'GitHub',
    gitlab: 'GitLab',
    linkedin: 'LinkedIn',
    youtube: 'YouTube',
    devto: 'DEV',
    kofi: 'Ko-fi',
    buymeacoffee: 'Buy Me a Coffee',
    linktree: 'Links page',
    microblog: 'Micro.blog',
    stackoverflow: 'Stack Overflow',
    soundcloud: 'SoundCloud',
    tiktok: 'TikTok',
    x: 'X',
    website: 'Website',
  };
  return names[network] ?? network.charAt(0).toUpperCase() + network.slice(1);
}

/**
 * The generated document, before the owner's corrections.
 *
 * @param {{
 *   person: { slug: string, name: string, bio?: string|null, avatar_url?: string|null,
 *             site_url?: string|null, links?: Array<{ network: string, url: string, handle?: string|null }> },
 *   feeds: Array<{ id: string, slug: string, title: string, kind?: string|null, role?: string|null,
 *                  feed_url?: string|null, site_url?: string|null, language?: string|null }>,
 *   topicsByFeed?: Map<string, string[]>,
 *   base: string,
 * }} input
 * @returns {import('@profullstack/openprofile').OpenProfileDoc}
 */
export function generateAuthorProfile({ person, feeds, topicsByFeed, base }) {
  const links = (person.links ?? []).filter((l) => l.network !== 'email');
  const handleLink = HANDLE_NETWORKS.map((n) => links.find((l) => l.network === n && l.handle)).find(
    Boolean,
  );

  const identity = {
    Kind: 'person',
    Handle: handleLink?.handle ? String(handleLink.handle).replace(/^@/, '') : null,
    Web: person.site_url ?? null,
    Avatar: person.avatar_url ?? null,
  };

  const headline = person.bio ? String(person.bio).split(/\r?\n/)[0].trim() : null;

  const accounts = links.map((l) =>
    l.network && l.network !== 'website' ? `[${label(l.network)}](${l.url})` : l.url,
  );

  // Topics: the union of every credited feed's strongest keywords, strongest
  // feed first so a podcaster's podcast outranks the group blog they write in.
  const topics = [];
  const seen = new Set();
  for (const f of feeds) {
    for (const t of topicsByFeed?.get(String(f.id)) ?? []) {
      const key = t.toLowerCase();
      if (seen.has(key) || topics.length >= MAX_TOPICS) continue;
      seen.add(key);
      topics.push(t);
    }
  }

  // Broadcast: one `### <show>` group per show they own. A feed they merely
  // write in is somebody else's show and is not theirs to describe.
  const shows = feeds.filter(
    (f) => BROADCAST_KINDS.has(String(f.kind ?? '')) && String(f.role ?? 'author') === 'owner',
  );
  const groups = shows.map((f) => {
    const keys = {
      Show: f.title,
      Kind: BROADCAST_KINDS.get(String(f.kind)) ?? null,
      Language: f.language ?? null,
      Feed: f.feed_url ?? null,
      Listen: f.site_url ?? `${base}/${encodeURIComponent(String(f.slug))}`,
      Topics: (topicsByFeed?.get(String(f.id)) ?? []).slice(0, 8).join(', ') || null,
    };
    const section = keyedSection('Broadcast', keys);
    return section ? `### ${f.title}\n\n${section.body}` : null;
  });
  const broadcast =
    shows.length === 1
      ? keyedSection('Broadcast', {
          Show: shows[0].title,
          Kind: BROADCAST_KINDS.get(String(shows[0].kind)) ?? null,
          Language: shows[0].language ?? null,
          Feed: shows[0].feed_url ?? null,
          Listen: shows[0].site_url ?? `${base}/${encodeURIComponent(String(shows[0].slug))}`,
          Topics: (topicsByFeed?.get(String(shows[0].id)) ?? []).slice(0, 8).join(', ') || null,
        })
      : groups.some(Boolean)
        ? { title: 'Broadcast', name: 'broadcast', body: groups.filter(Boolean).join('\n\n') }
        : null;

  // Links: the feeds themselves, so a reader that only has the profile can
  // still reach the writing. Owned feeds first.
  const feedLinks = [...feeds]
    .sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner'))
    .slice(0, 20)
    .map((f) => `[${f.title}](${base}/${encodeURIComponent(String(f.slug))})`);

  return makeOpenProfile({
    name: String(person.name),
    identity,
    headline,
    sections: [
      listSection('Accounts', accounts),
      listSection('Topics', topics),
      broadcast,
      listSection('Links', feedLinks),
    ],
  });
}

/**
 * The document as served: generated, then the owner's overlay on top.
 *
 * @param {Parameters<typeof generateAuthorProfile>[0] & { overrides?: Record<string, any>|null }} input
 * @returns {{ generated: import('@profullstack/openprofile').OpenProfileDoc,
 *             doc: import('@profullstack/openprofile').OpenProfileDoc, markdown: string }}
 */
export function authorProfile(input) {
  const generated = generateAuthorProfile(input);
  const doc = applyOverrides(generated, input.overrides ?? null);
  return { generated, doc, markdown: renderOpenProfile(doc) };
}

/**
 * The overlay a PUT produces, from either body shape.
 *
 * A Markdown body is the whole file the owner edited: everything in it
 * becomes an override, and a section the file dropped is dropped. A JSON body
 * is a partial patch, merged over what is stored.
 *
 * @param {{ contentType: string, text: string, existing: Record<string, any>|null,
 *           generated: import('@profullstack/openprofile').OpenProfileDoc }} input
 * @returns {{ overrides: Record<string, any>, public?: boolean, error?: string }}
 */
export function overridesFromBody({ contentType, text, existing, generated }) {
  if (/markdown|text\/plain/i.test(contentType)) {
    if (!text.trim()) return { overrides: existing ?? {}, error: 'empty document' };
    return { overrides: overridesFromDocument(text, generated, true) };
  }

  let body;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    return { overrides: existing ?? {}, error: 'bad JSON' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { overrides: existing ?? {}, error: 'expected an object' };
  }

  if (typeof body.markdown === 'string') {
    return {
      overrides: overridesFromDocument(body.markdown, generated, true),
      ...(typeof body.public === 'boolean' ? { public: body.public } : {}),
    };
  }

  const patch = {};
  if (body.name !== undefined) patch.name = body.name == null ? null : String(body.name);
  if (body.headline !== undefined) patch.headline = body.headline == null ? null : String(body.headline);
  if (body.prose !== undefined) patch.prose = body.prose == null ? null : String(body.prose);
  if (body.identity && typeof body.identity === 'object') {
    patch.identity = {};
    for (const [k, v] of Object.entries(body.identity)) patch.identity[k] = v == null ? null : String(v);
  }
  if (body.sections && typeof body.sections === 'object') {
    patch.sections = {};
    for (const [k, v] of Object.entries(body.sections)) patch.sections[k] = v == null ? 'none' : String(v);
  }

  return {
    overrides: mergeOverrides(existing ?? {}, patch),
    ...(typeof body.public === 'boolean' ? { public: body.public } : {}),
  };
}

/**
 * The overlay the web form produces. Every field is the whole value of that
 * part of the file, so an emptied field removes what it held.
 *
 * @param {FormData} form
 * @returns {{ overrides: Record<string, any>, public: boolean }}
 */
export function overridesFromForm(form) {
  const str = (name) => String(form.get(name) ?? '').trim();
  const identity = {};
  for (const line of str('identity').split(/\r?\n/)) {
    const m = /^\s*-?\s*\*{0,2}([^:*]+?)\*{0,2}\s*:\s*(.*)$/.exec(line);
    if (m) identity[m[1].trim()] = m[2].trim() || null;
  }
  const sections = {};
  for (const name of ['accounts', 'topics', 'broadcast', 'guest', 'about', 'links', 'reshare']) {
    const value = str(`section_${name}`);
    if (form.has(`section_${name}`)) sections[name] = value || 'none';
  }
  return {
    overrides: {
      ...(str('name') ? { name: str('name') } : {}),
      headline: str('headline') || null,
      identity,
      sections,
    },
    public: form.get('public') != null,
  };
}

/**
 * Where an author's profile lives.
 *
 * @param {string} base
 * @param {string} slug
 * @returns {string}
 */
export function profileUrl(base, slug) {
  return `${base}/authors/${encodeURIComponent(slug)}/openprofile.md`;
}
