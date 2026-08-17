import { parseHTML } from 'linkedom';

/**
 * Working out who writes a feed, and where else they can be found.
 *
 * The directory indexes the small web, which is the one part of the internet
 * where this is tractable. A person who runs their own blog generally also
 * says, on that blog, where else they are: an IndieWeb `rel="me"` set, an
 * `h-card`, a JSON-LD `Person` with `sameAs`, a Linktree in the footer. None
 * of that is scraped from a platform or bought from a data vendor — it is
 * published, by the author, for exactly this purpose.
 *
 * Two rules run through the whole module, and both cost recall on purpose:
 *
 * - **A role is not a person.** "Editor", "Staff", "webmaster", `info@` — the
 *   directory already learned this the expensive way in a sibling project,
 *   where role mailboxes were stored as people and then emailed. Anything
 *   that smells like a shared account is dropped here, at extraction, rather
 *   than stored and filtered by whoever reads the table later.
 * - **A name is not an identity.** Names are not unique and never will be, so
 *   nothing in this module merges two people because they are both called
 *   John Smith. Merging happens on a URL the author controls, and only there.
 *
 * Everything here is pure: it takes a parsed document or a string of HTML and
 * returns candidates. Fetching, scheduling and storage live in
 * `@rssamplifier/ingest`, which is what makes this file testable without a
 * network.
 */

/** Longest a byline can be before it is a sentence that landed in the wrong element. */
const MAX_NAME_LENGTH = 60;

/**
 * Words that mean "somebody at this organisation" rather than a person.
 *
 * Matched against the whole normalized name, never as a substring: "Contact
 * Nguyen" and "Adam Staffordshire" are people, and a substring test would lose
 * both. The multi-word entries are the ones that appear whole.
 */
const ROLE_NAMES = new Set([
  'admin',
  'administrator',
  'author',
  'contact',
  'contributor',
  'correspondent',
  'editor',
  'editors',
  'editorial',
  'editorial board',
  'editorial staff',
  'editorial team',
  'guest',
  'guest author',
  'guest post',
  'info',
  'moderator',
  'news desk',
  'news staff',
  'newsroom',
  'noreply',
  'no reply',
  'staff',
  'staff writer',
  'staff writers',
  'support',
  'team',
  'the editor',
  'the editors',
  'the team',
  'unknown',
  'anonymous',
  'webmaster',
  'wordpress',
  'root',
  'user',
  'guest contributor',
  'press office',
  'press team',
  'media team',
  'marketing',
  'marketing team',
  'sales',
  'sales team',
  'hello',
  'enquiries',
  'inquiries',
]);

/**
 * Local parts that make an address a shared mailbox.
 *
 * Held separately from ROLE_NAMES because the two lists disagree: "team" is
 * both, but "jobs" is only ever a mailbox and "editors" is only ever a byline.
 */
const ROLE_MAILBOXES = new Set([
  'admin',
  'administrator',
  'billing',
  'contact',
  'enquiries',
  'feedback',
  'help',
  'hello',
  'hi',
  'info',
  'information',
  'inquiries',
  'jobs',
  'legal',
  'mail',
  'marketing',
  'media',
  'news',
  'newsletter',
  'noreply',
  'no-reply',
  'office',
  'postmaster',
  'press',
  'privacy',
  'sales',
  'security',
  'social',
  'support',
  'team',
  'webmaster',
  'abuse',
  'careers',
  'partnerships',
  'subscribe',
  'unsubscribe',
]);

/**
 * The link aggregators worth following one hop.
 *
 * A Linktree is not itself a way to reach anyone — it is a page of links to
 * the accounts that are. Following it turns one useless row into five useful
 * ones, and these hosts are the ones where every link on the page belongs to
 * the same person by construction, which is what makes the hop safe.
 */
export const BIO_HOSTS = new Set([
  'linktr.ee',
  'bio.link',
  'beacons.ai',
  'campsite.bio',
  'taplink.cc',
  'solo.to',
  'lnk.bio',
  'allmylinks.com',
  'hoo.be',
  'magic.ly',
  'many.link',
  'shor.by',
  'withkoji.com',
  'liinks.co',
  'links.page',
  'bento.me',
  'about.me',
  'linkin.bio',
  'msha.ke',
  'contactin.bio',
]);

/**
 * Profile URL shapes, most specific first.
 *
 * Order matters: `medium.com/@jane` must be read as Medium rather than as the
 * generic `/@handle` shape that identifies the fediverse, so the named hosts
 * are tested before the structural rule.
 *
 * `path` captures the handle. A pattern that matches the host but not the path
 * is a link to the platform, not to a person, and is dropped.
 */
const PROFILE_PATTERNS = [
  { network: 'github', host: /^(?:www\.)?github\.com$/, path: /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/?$/ },
  { network: 'gitlab', host: /^(?:www\.)?gitlab\.com$/, path: /^\/([A-Za-z0-9][\w.-]{1,254})\/?$/ },
  { network: 'codeberg', host: /^codeberg\.org$/, path: /^\/([A-Za-z0-9][\w.-]{0,38})\/?$/ },
  { network: 'sourcehut', host: /^git\.sr\.ht$/, path: /^\/~([\w.-]{1,64})\/?$/ },
  { network: 'bluesky', host: /^(?:www\.)?bsky\.app$/, path: /^\/profile\/([\w.:-]+)\/?$/ },
  { network: 'twitter', host: /^(?:www\.|mobile\.)?(?:twitter\.com|x\.com)$/, path: /^\/(\w{1,15})\/?$/ },
  { network: 'linkedin', host: /^(?:[a-z]{2}\.)?(?:www\.)?linkedin\.com$/, path: /^\/in\/([\w%-]{1,120})\/?$/ },
  { network: 'youtube', host: /^(?:www\.|m\.)?youtube\.com$/, path: /^\/(?:@([\w.-]{1,120})|c\/([\w.-]{1,120})|channel\/(UC[\w-]{20,26})|user\/([\w.-]{1,120}))\/?$/ },
  { network: 'instagram', host: /^(?:www\.)?instagram\.com$/, path: /^\/([\w.]{1,30})\/?$/ },
  { network: 'tiktok', host: /^(?:www\.)?tiktok\.com$/, path: /^\/@([\w.]{1,30})\/?$/ },
  { network: 'threads', host: /^(?:www\.)?threads\.(?:net|com)$/, path: /^\/@([\w.]{1,30})\/?$/ },
  { network: 'facebook', host: /^(?:www\.|web\.|m\.)?facebook\.com$/, path: /^\/([\w.]{3,60})\/?$/ },
  { network: 'reddit', host: /^(?:www\.|old\.|new\.)?reddit\.com$/, path: /^\/u(?:ser)?\/([\w-]{1,30})\/?$/ },
  { network: 'medium', host: /^(?:www\.)?medium\.com$/, path: /^\/@([\w.-]{1,60})\/?$/ },
  { network: 'devto', host: /^dev\.to$/, path: /^\/([\w-]{1,60})\/?$/ },
  { network: 'hashnode', host: /^hashnode\.com$/, path: /^\/@([\w-]{1,60})\/?$/ },
  { network: 'patreon', host: /^(?:www\.)?patreon\.com$/, path: /^\/([\w-]{1,60})\/?$/ },
  { network: 'kofi', host: /^(?:www\.)?ko-fi\.com$/, path: /^\/([\w-]{1,60})\/?$/ },
  { network: 'buymeacoffee', host: /^(?:www\.)?buymeacoffee\.com$/, path: /^\/([\w-]{1,60})\/?$/ },
  { network: 'keybase', host: /^keybase\.io$/, path: /^\/([\w-]{1,60})\/?$/ },
  { network: 'telegram', host: /^(?:www\.)?t\.me$/, path: /^\/([\w]{5,32})\/?$/ },
  { network: 'matrix', host: /^matrix\.to$/, path: /^\/#\/(@[^/]+)\/?$/ },
  { network: 'flickr', host: /^(?:www\.)?flickr\.com$/, path: /^\/(?:people|photos)\/([\w@.-]{1,64})\/?$/ },
  { network: 'goodreads', host: /^(?:www\.)?goodreads\.com$/, path: /^\/(?:author\/show|user\/show)\/([\w.-]{1,64})\/?$/ },
  { network: 'stackoverflow', host: /^(?:www\.)?stackoverflow\.com$/, path: /^\/users\/(\d+)(?:\/[\w-]*)?\/?$/ },
  { network: 'twitch', host: /^(?:www\.)?twitch\.tv$/, path: /^\/([\w]{3,25})\/?$/ },
  { network: 'soundcloud', host: /^(?:www\.)?soundcloud\.com$/, path: /^\/([\w-]{1,60})\/?$/ },
  { network: 'bandcamp', host: /^([\w-]{1,60})\.bandcamp\.com$/, path: /^\/?$/, fromHost: true },
  { network: 'substack', host: /^([\w-]{1,60})\.substack\.com$/, path: /^\/?$/, fromHost: true },
];

/**
 * The fediverse, which has no host list because that is the point of it.
 *
 * Mastodon, Pleroma, Akkoma, GoToSocial and Pixelfed all publish a profile at
 * `/@handle` on a domain of the operator's choosing, so the shape is the only
 * thing they have in common. Tested last, after every named host above, so the
 * platforms that happen to use the same shape are not swept up in it.
 */
const FEDIVERSE_PATH = /^\/(?:@|users\/)([A-Za-z0-9_]{1,30})\/?$/;

/**
 * Collapse whitespace and case for comparison.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Strip the decoration publishers put around a byline.
 *
 * "By Jane Doe", "Written by Jane Doe", "Jane Doe |", "— Jane Doe".
 *
 * @param {unknown} value
 * @returns {string} the name as written, minus the furniture
 */
export function cleanName(value) {
  let name = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  name = name.replace(/^(?:by|written by|posted by|author:?)\s+/i, '');
  // Trailing separators and the site name publishers append after them.
  name = name.replace(/\s*[|·•—–-]\s*$/, '');
  // An RSS author is defined as an address, and most publishers write
  // "jane@example.com (Jane Doe)" — the parenthesised part is the name.
  const parenthesised = name.match(/^\S+@\S+\s*\((.+)\)$/);
  if (parenthesised) name = parenthesised[1].trim();

  return name.trim();
}

/**
 * Does this read as a person's name?
 *
 * Deliberately conservative in one direction only. A false positive is stored,
 * published on a page and eventually emailed; a false negative is a blog whose
 * author we do not know, which is where every feed starts anyway.
 *
 * Mononyms pass — plenty of the small web signs one name — but handles do not,
 * because "keizerharm" and "user86791" are accounts rather than people and the
 * distinction is exactly the one a directory of blogs should keep.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksLikePersonName(value) {
  const name = cleanName(value);
  if (!name || name.length > MAX_NAME_LENGTH) return false;

  const normalized = normalizeName(name);
  if (ROLE_NAMES.has(normalized)) return false;
  // "The editorial team", "our newsroom". Enumerating every article a
  // publisher might put in front of a role is a list that never ends, so the
  // article comes off and the role is matched underneath it.
  if (ROLE_NAMES.has(normalized.replace(/^(?:the|our|a)\s+/, ''))) return false;

  // An address is not a name, and neither is a URL.
  if (/@/.test(name) && !/\s/.test(name)) return false;
  if (/^https?:\/\//i.test(name)) return false;

  const words = name.split(/\s+/).filter(Boolean);
  // Six words is a sentence. "Dr. Maria del Carmen Ruiz Lopez" is five.
  if (words.length > 5) return false;

  // A phrase ending in a collective noun is a group, whatever the words in
  // front of it: "Wirecutter Staff", "The Verge editorial board", "News Desk".
  // Only applied to phrases, so a person whose whole name is "Crew" is safe.
  if (words.length > 1 && /^(?:team|staff|desk|board|crew|bot|editors|writers|contributors)$/i.test(words.at(-1))) {
    return false;
  }

  // Every word must contain a letter: "Jane Doe" yes, "12 34" no.
  if (!words.every((word) => /\p{L}/u.test(word))) return false;

  if (words.length === 1) {
    const only = words[0];
    // A mononym is a name a person chose; a handle is a string a database
    // assigned. Digits, underscores and dots are how you tell them apart.
    if (/[\d_]/.test(only)) return false;
    if (only.length < 2) return false;
    // "keizerharm" — all lower case with no separator reads as a login, and a
    // person signing one name capitalises it.
    if (only === only.toLowerCase() && only.length > 3) return false;
    // "KeizerHarm" — two words with the space taken out, which is a username
    // rather than a name. The exceptions are the handful of prefixes that
    // really do carry a capital into the middle of a surname, and they are
    // worth naming because "McDonald" and "O'Brien" are people.
    if (/\p{Ll}\p{Lu}/u.test(only) && !/^(?:Mc|Mac|De|Di|Du|La|Le|Van|Von|O')\p{Lu}/u.test(only)) {
      return false;
    }
  }

  return true;
}

/**
 * Split a credit line into the people in it.
 *
 * "Adam Wren, Dasha Burns and Will Steakin" is three people. Splitting is done
 * before the person test so a list containing one role — "Jane Doe and the
 * editorial team" — keeps Jane and drops the team.
 *
 * @param {unknown} value
 * @returns {string[]} names as written, deduplicated, furniture removed
 */
export function splitBylines(value) {
  const raw = cleanName(value);
  if (!raw) return [];

  const seen = new Set();
  const names = [];

  for (const part of raw.split(/\s*(?:,|;|&|\/|\band\b|\bwith\b)\s*/i)) {
    const name = cleanName(part);
    if (!name || !looksLikePersonName(name)) continue;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

/**
 * Is this address a shared mailbox rather than a person's?
 *
 * @param {unknown} value
 * @returns {boolean} true for anything that must not be stored as a person's email
 */
export function isRoleEmail(value) {
  const address = String(value ?? '')
    .replace(/^mailto:/i, '')
    .split('?')[0]
    .trim()
    .toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return true;

  const local = address.split('@')[0];
  if (ROLE_MAILBOXES.has(local)) return true;
  // "no-reply", "press.office", "info+blog" — a shared mailbox with a suffix.
  const stem = local.split(/[+._-]/)[0];
  return ROLE_MAILBOXES.has(stem);
}

/**
 * Pull a usable address out of the several ways feeds write one.
 *
 * @param {unknown} value
 * @returns {string} the address, or '' when there is none or it is a role mailbox
 */
export function personalEmail(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const match = raw.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  if (!match) return '';

  const address = match[0].toLowerCase();
  return isRoleEmail(address) ? '' : address;
}

/**
 * Reduce a URL to the form two copies of the same profile share.
 *
 * Tracking parameters, a trailing slash and http-vs-https are the three ways
 * the same link arrives looking different, and all three would otherwise
 * create a second row for an account already stored.
 *
 * @param {unknown} value
 * @param {string} [base] resolves a relative href
 * @returns {string} '' when the input is not a usable http(s) URL
 */
export function normalizeIdentityUrl(value, base = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  let url;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return '';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

  url.hash = '';
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|ref$|ref_|fbclid|gclid|mc_|source$|si$)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  // A profile is the same profile over either scheme, and the fediverse is
  // full of links written both ways.
  url.protocol = 'https:';
  if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);

  return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '');
}

/**
 * Which network a URL is a profile on, and the handle in it.
 *
 * Returns null for a link that is not a personal profile — a repository, a
 * platform's front page, a news article. That rejection is most of the value:
 * a blog's footer links to plenty of things that are not its author.
 *
 * @param {unknown} value
 * @param {string} [base]
 * @returns {{ network: string, url: string, handle: string } | null}
 */
export function classifyLink(value, base = '') {
  const raw = String(value ?? '').trim();

  if (/^mailto:/i.test(raw)) {
    const address = personalEmail(raw);
    return address ? { network: 'email', url: `mailto:${address}`, handle: address } : null;
  }

  const url = normalizeIdentityUrl(raw, base);
  if (!url) return null;

  const parsed = new URL(url);
  const host = parsed.hostname;
  const path = parsed.pathname;

  for (const pattern of PROFILE_PATTERNS) {
    const hostMatch = host.match(pattern.host);
    if (!hostMatch) continue;
    const pathMatch = path.match(pattern.path);
    if (!pathMatch) return null;

    const handle = pattern.fromHost
      ? hostMatch[1]
      : (pathMatch.slice(1).find(Boolean) ?? '');
    if (!handle) return null;
    return { network: pattern.network, url, handle };
  }

  if (BIO_HOSTS.has(host)) {
    const handle = path.replace(/^\//, '').split('/')[0];
    return { network: 'linktree', url, handle: handle || host };
  }

  const fediverse = path.match(FEDIVERSE_PATH);
  if (fediverse) {
    return { network: 'fediverse', url, handle: `@${fediverse[1]}@${host}` };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Credits from the feed document
 * ------------------------------------------------------------------ */

/** @param {unknown} v */
const text = (v) => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim();
/** @param {unknown} v */
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/**
 * One credited person, before anything has been stored or merged.
 *
 * @typedef {object} Credit
 * @property {string} name
 * @property {string} email '' when none was published, or it was a role mailbox
 * @property {string} url '' when the feed did not link them
 * @property {string} avatar
 * @property {'author'|'owner'} role owner is responsible for the feed; author writes in it
 * @property {string} source the element it came from, for debugging a bad byline
 * @property {number} confidence 0..1
 */

/**
 * Fold a list of credits down to one entry per person.
 *
 * Keyed on the name because within a single feed document a name is a
 * sufficient key — the ambiguity this module worries about is between feeds,
 * not inside one. The strongest evidence for each field wins, so an owner
 * credit carrying an email is not lost to a later byline that carries none.
 *
 * @param {Credit[]} credits
 * @returns {Credit[]}
 */
export function mergeCredits(credits) {
  /** @type {Map<string, Credit>} */
  const byName = new Map();

  for (const credit of credits) {
    if (!credit?.name) continue;
    const key = normalizeName(credit.name);
    const existing = byName.get(key);

    if (!existing) {
      byName.set(key, { ...credit });
      continue;
    }

    absorb(existing, credit);
  }

  // A site that signs "Jeena" in one place and "Jeena Paradies" in another is
  // one person, and jeena.net does exactly that — an h-card name and a feed
  // author element disagreeing about how formal to be. Left alone it produced
  // two author rows and two pages for one blogger.
  //
  // Only a first-name match, and only within a single document's credits,
  // where the strongest counter-example — a group blog with a Sam and a Sam
  // Ruiz who are different people — is rare enough to be worth the trade. The
  // fuller name wins, because it is the one somebody would search for.
  const names = [...byName.values()];
  const merged = [];

  for (const person of names.sort((a, b) => b.name.length - a.name.length)) {
    const first = normalizeName(person.name).split(' ')[0];
    const fuller = merged.find(
      (other) =>
        normalizeName(other.name).split(' ')[0] === first &&
        normalizeName(other.name).split(' ').length > normalizeName(person.name).split(' ').length,
    );

    if (fuller && normalizeName(person.name).split(' ').length === 1) absorb(fuller, person);
    else merged.push(person);
  }

  return merged;
}

/**
 * Fold one credit's evidence into another's, strongest wins.
 *
 * @param {Credit} into
 * @param {Credit} from
 */
function absorb(into, from) {
  into.email ||= from.email;
  into.url ||= from.url;
  into.avatar ||= from.avatar;
  into.confidence = Math.max(into.confidence, from.confidence);
  // Owner outranks author: it is the stronger claim about the feed.
  if (from.role === 'owner') into.role = 'owner';
  if (!into.source.includes(from.source)) into.source += `,${from.source}`;
}

/**
 * Build one credit, or null when the name does not survive the person test.
 *
 * @param {object} input
 * @param {unknown} input.name
 * @param {unknown} [input.email]
 * @param {unknown} [input.url]
 * @param {unknown} [input.avatar]
 * @param {'author'|'owner'} [input.role]
 * @param {string} input.source
 * @param {number} input.confidence
 * @param {string} [input.base]
 * @returns {Credit | null}
 */
export function credit({ name, email, url, avatar, role = 'author', source, confidence, base = '' }) {
  const cleaned = cleanName(name);
  if (!looksLikePersonName(cleaned)) return null;

  return {
    name: cleaned,
    email: personalEmail(email ?? name),
    url: normalizeIdentityUrl(url, base),
    avatar: normalizeIdentityUrl(avatar, base),
    role,
    source,
    confidence,
  };
}

/**
 * Everyone the feed document itself credits.
 *
 * The channel-level elements are trusted more than the item bylines: an
 * `itunes:owner` or an Atom `<author>` on the feed is a statement about who
 * publishes the whole thing, while a `dc:creator` on one post is a statement
 * about one post — true, but a feed with fifty guest posts is not fifty
 * people's blog.
 *
 * `podcast:person` is the best-specified of the lot. Podcasting 2.0 defines
 * name, role, an `href` to their page and an `img`, which is more than most of
 * the web publishes about anybody.
 *
 * @param {any} channel the raw parsed channel/feed object
 * @param {any[]} items the raw parsed items
 * @param {'rss'|'atom'|'rdf'|'json'} format
 * @param {string} [base] the feed URL, for resolving relative links
 * @returns {Credit[]}
 */
export function feedCredits(channel, items, format, base = '') {
  const found = [];
  const ch = channel ?? {};

  if (format === 'json') {
    // JSON Feed 1.1 replaced the single `author` with `authors`, and
    // publishers emit both; reading each in turn costs nothing.
    for (const author of [...arr(ch.authors), ch.author]) {
      if (!author) continue;
      found.push(
        credit({
          name: author.name,
          url: author.url,
          avatar: author.avatar,
          role: 'owner',
          source: 'json-feed-author',
          confidence: 0.8,
          base,
        }),
      );
    }
  }

  if (format === 'atom') {
    for (const author of arr(ch.author)) {
      found.push(
        credit({
          name: author?.name ?? author,
          email: author?.email,
          url: author?.uri,
          role: 'owner',
          source: 'atom-feed-author',
          confidence: 0.85,
          base,
        }),
      );
    }
    for (const contributor of arr(ch.contributor)) {
      found.push(
        credit({
          name: contributor?.name ?? contributor,
          email: contributor?.email,
          url: contributor?.uri,
          source: 'atom-contributor',
          confidence: 0.5,
          base,
        }),
      );
    }
  }

  if (format === 'rss' || format === 'rdf') {
    // managingEditor is defined as an address and conventionally written
    // "jane@example.com (Jane Doe)", which cleanName already understands.
    found.push(
      credit({
        name: ch.managingEditor,
        email: ch.managingEditor,
        role: 'owner',
        source: 'managing-editor',
        confidence: 0.8,
      }),
    );
    // webMaster is the person who runs the server, which on the small web is
    // usually the same person and in a newsroom never is. Believed, but at a
    // confidence that says so.
    found.push(
      credit({
        name: ch.webMaster,
        email: ch.webMaster,
        role: 'owner',
        source: 'web-master',
        confidence: 0.4,
      }),
    );
    found.push(
      credit({
        name: ch['itunes:author'],
        role: 'owner',
        source: 'itunes-author',
        confidence: 0.7,
      }),
    );
    const owner = ch['itunes:owner'];
    if (owner) {
      found.push(
        credit({
          name: owner['itunes:name'] ?? owner.name,
          email: owner['itunes:email'] ?? owner.email,
          role: 'owner',
          source: 'itunes-owner',
          confidence: 0.85,
        }),
      );
    }
    found.push(
      credit({
        name: ch['dc:creator'],
        role: 'owner',
        source: 'channel-dc-creator',
        confidence: 0.75,
      }),
    );

    // Podcasting 2.0. `role` distinguishes a host from a guest, and a guest is
    // not an author of the feed — they appeared on one episode of it.
    for (const person of arr(ch['podcast:person'])) {
      const personRole = String(person?.['@role'] ?? '').toLowerCase();
      if (personRole && !/host|owner|author|creator|producer/.test(personRole)) continue;
      found.push(
        credit({
          name: person?.['#text'] ?? person,
          url: person?.['@href'],
          avatar: person?.['@img'],
          role: 'owner',
          source: 'podcast-person',
          confidence: 0.9,
          base,
        }),
      );
    }
  }

  // Item bylines. Capped at a sample rather than the whole window: a feed
  // carries up to forty items and reading every one of them to find the same
  // two names is work the crawler does thousands of times an hour.
  const feedTitle = normalizeName(ch.title);
  for (const item of arr(items).slice(0, 25)) {
    const raw =
      format === 'json'
        ? (arr(item?.authors)[0]?.name ?? item?.author?.name)
        : (item?.['dc:creator'] ?? item?.author?.name ?? item?.author);

    // Blot writes the post's own title into dc:creator on every entry, which
    // would otherwise credit a blog to twelve people named after its posts.
    if (normalizeName(raw) && normalizeName(raw) === normalizeName(item?.title)) continue;
    if (normalizeName(raw) === feedTitle) continue;

    for (const name of splitBylines(raw)) {
      found.push(
        credit({
          name,
          email: raw,
          source: 'item-byline',
          confidence: 0.6,
        }),
      );
    }
  }

  return mergeCredits(found.filter(Boolean));
}

/* ------------------------------------------------------------------ *
 * Identity from the site's HTML
 * ------------------------------------------------------------------ */

/** Cap on the links read out of one page, so a link farm cannot flood a person. */
const MAX_PAGE_LINKS = 40;

/**
 * Read every identity claim a page makes.
 *
 * Four sources, in descending order of how deliberate they are:
 *
 * 1. `rel="me"` — the IndieWeb convention, published for precisely this. A
 *    link marked this way is the author saying "that account is mine".
 * 2. `h-card` — microformats2, the same community's way of publishing a name,
 *    a photo, a URL and an address as structured data in the visible page.
 * 3. JSON-LD `Person` with `sameAs` — schema.org's equivalent, emitted by
 *    WordPress and Ghost without the author having to do anything.
 * 4. Ordinary links that happen to be profiles. The weakest: a footer icon row
 *    may belong to the publication rather than to any person, which is why the
 *    source is recorded and the caller decides what to do about it.
 *
 * @param {string} html
 * @param {string} baseUrl the page the HTML came from
 * @returns {{
 *   name: string, bio: string, avatar: string, email: string, url: string,
 *   relMe: Array<{ network: string, url: string, handle: string }>,
 *   profiles: Array<{ network: string, url: string, handle: string, source: string }>,
 *   credits: Credit[]
 * }}
 */
export function identityFromHtml(html, baseUrl = '') {
  const empty = {
    name: '',
    bio: '',
    avatar: '',
    email: '',
    url: '',
    relMe: [],
    profiles: [],
    credits: [],
  };
  if (typeof html !== 'string' || !html.trim()) return empty;

  let document;
  try {
    ({ document } = parseHTML(html));
  } catch {
    return empty;
  }

  const base = canonicalBase(document, baseUrl);
  /** @type {Map<string, { network: string, url: string, handle: string, source: string }>} */
  const profiles = new Map();
  const relMe = [];
  const credits = [];

  const add = (href, source) => {
    const hit = classifyLink(href, base);
    if (!hit) return null;
    const existing = profiles.get(hit.url);
    // A link found twice keeps its strongest provenance: rel="me" beats a
    // footer icon, and the order below is what decides which one that is.
    if (!existing) profiles.set(hit.url, { ...hit, source });
    return hit;
  };

  // 1. rel="me", on <a> and on <link> alike — some sites put it in the head.
  for (const el of document.querySelectorAll('[rel~="me"]')) {
    const hit = add(el.getAttribute('href'), 'rel-me');
    if (hit) relMe.push(hit);
  }

  // 2. h-card.
  const card = document.querySelector('.h-card');
  let name = '';
  let bio = '';
  let avatar = '';
  let email = '';
  let url = '';

  if (card) {
    name = cleanName(pick(card, '.p-name') || card.getAttribute('title') || '');
    bio = trimTo(pick(card, '.p-note, .p-summary'), 400);
    avatar = normalizeIdentityUrl(attr(card, '.u-photo', 'src') || attr(card, '.u-photo', 'href'), base);
    email = personalEmail(attr(card, '.u-email', 'href'));
    url = normalizeIdentityUrl(attr(card, '.u-url', 'href'), base);

    for (const el of card.querySelectorAll('a[href]')) add(el.getAttribute('href'), 'h-card');

    const fromCard = credit({
      name,
      email,
      url,
      avatar,
      role: 'owner',
      source: 'h-card',
      confidence: 0.85,
      base,
    });
    if (fromCard) credits.push(fromCard);
  }

  // 3. JSON-LD.
  for (const person of jsonLdPeople(document)) {
    for (const same of arr(person.sameAs)) add(same, 'json-ld');

    const fromLd = credit({
      name: person.name,
      email: person.email,
      url: person.url,
      avatar: typeof person.image === 'string' ? person.image : person.image?.url,
      role: 'owner',
      source: 'json-ld',
      confidence: 0.8,
      base,
    });
    if (fromLd) {
      credits.push(fromLd);
      name ||= fromLd.name;
      avatar ||= fromLd.avatar;
      email ||= fromLd.email;
      url ||= fromLd.url;
      bio ||= trimTo(person.description, 400);
    }
  }

  // <meta name="author"> and <link rel="author">, which is what a site with
  // none of the above still tends to publish.
  const metaAuthor = attr(document, 'meta[name="author" i]', 'content');
  const fromMeta = credit({
    name: metaAuthor,
    source: 'meta-author',
    confidence: 0.55,
    base,
  });
  if (fromMeta) {
    credits.push(fromMeta);
    name ||= fromMeta.name;
  }

  // 4. Everything else that parses as a profile. Bounded, and last, so it can
  // only fill gaps the deliberate sources left.
  let seen = 0;
  for (const el of document.querySelectorAll('a[href]')) {
    if (seen >= MAX_PAGE_LINKS) break;
    if (add(el.getAttribute('href'), 'page-link')) seen += 1;
  }

  return {
    name,
    bio,
    avatar,
    email,
    url,
    relMe,
    profiles: [...profiles.values()],
    credits: mergeCredits(credits),
  };
}

/**
 * The links on a bio page, which all belong to whoever owns the page.
 *
 * Linktree and its imitators render client-side, so the anchors are often not
 * in the HTML at all — the page ships its links inside a Next.js `__NEXT_DATA__`
 * blob instead. Both are read, because a page that returns nothing from the
 * DOM usually returns everything from the JSON.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @returns {Array<{ network: string, url: string, handle: string, source: string }>}
 */
export function linksFromBioPage(html, baseUrl = '') {
  if (typeof html !== 'string' || !html.trim()) return [];

  /** @type {Map<string, { network: string, url: string, handle: string, source: string }>} */
  const links = new Map();

  const add = (href) => {
    const hit = classifyLink(href, baseUrl);
    // A bio page links to itself in its own share button; storing that would
    // give the author a Linktree whose only content is the Linktree.
    if (!hit || hit.network === 'linktree') return;
    if (!links.has(hit.url)) links.set(hit.url, { ...hit, source: 'linktree' });
  };

  try {
    const { document } = parseHTML(html);
    for (const el of document.querySelectorAll('a[href]')) add(el.getAttribute('href'));
  } catch {
    // Unparseable markup still has URLs in it; fall through to the scan below.
  }

  // Any absolute URL in the source, which catches the JSON payloads. Capped,
  // and every candidate still has to classify as a profile to be kept.
  const urls = String(html).match(/https?:\/\/[^\s"'<>\\)]+/g) ?? [];
  for (const url of urls.slice(0, 500)) add(url);

  return [...links.values()];
}

/**
 * Does this page link back to `url` with rel="me"?
 *
 * The IndieWeb handshake: a link from a blog to a Mastodon account is a claim,
 * and the same link coming back is the proof. Mastodon, GitHub and most
 * profile pages mark their website field this way without being asked.
 *
 * @param {string} html the profile page's HTML
 * @param {string} url the author's own URL, which the profile should point at
 * @returns {boolean}
 */
export function linksBackTo(html, url) {
  const target = normalizeIdentityUrl(url);
  if (!target || typeof html !== 'string' || !html.trim()) return false;

  let document;
  try {
    ({ document } = parseHTML(html));
  } catch {
    return false;
  }

  const wanted = new URL(target);
  for (const el of document.querySelectorAll('[rel~="me"]')) {
    const href = normalizeIdentityUrl(el.getAttribute('href'));
    if (!href) continue;
    const found = new URL(href);
    // Host and path, so a link to the site's front page verifies an author
    // whose URL carries a trailing index — and a link to somebody else's blog
    // on the same host does not.
    if (found.hostname === wanted.hostname && found.pathname === wanted.pathname) return true;
  }

  return false;
}

/**
 * The key two records must share before they are treated as the same person.
 *
 * A URL the author controls when there is one; name-plus-host otherwise, which
 * never merges across sites and so never merges two different John Smiths.
 *
 * @param {{ name: string, url?: string }} person
 * @param {string} feedUrl the feed they were found on
 * @returns {string}
 */
export function identityKey(person, feedUrl = '') {
  const url = normalizeIdentityUrl(person?.url);
  if (url) return url;

  let host = '';
  try {
    host = new URL(feedUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    host = '';
  }

  return `${normalizeName(person?.name)}@${host}`;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/**
 * The URL relative links on this page resolve against.
 *
 * @param {any} document
 * @param {string} fallback
 * @returns {string}
 */
function canonicalBase(document, fallback) {
  const declared = document.querySelector('base[href]')?.getAttribute('href');
  if (!declared) return fallback;
  try {
    return new URL(declared, fallback || undefined).toString();
  } catch {
    return fallback;
  }
}

/**
 * @param {any} root
 * @param {string} selector
 * @returns {string}
 */
function pick(root, selector) {
  const el = root.querySelector(selector);
  if (!el) return '';
  // A microformat property can sit on a <img alt> or an <abbr title> as well
  // as on ordinary text, which is what the spec's value rules are about.
  return String(el.getAttribute('alt') || el.getAttribute('title') || el.textContent || '').trim();
}

/**
 * @param {any} root
 * @param {string} selector
 * @param {string} attribute
 * @returns {string}
 */
function attr(root, selector, attribute) {
  return String(root.querySelector(selector)?.getAttribute(attribute) ?? '').trim();
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function trimTo(value, max) {
  const text_ = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text_.length > max ? `${text_.slice(0, max - 1)}…` : text_;
}

/**
 * Every schema.org Person in the page's JSON-LD.
 *
 * Publishers nest them arbitrarily — inside `@graph`, inside an Article's
 * `author`, inside a WebSite's `publisher` — so the whole tree is walked
 * rather than the top level read.
 *
 * @param {any} document
 * @returns {any[]}
 */
function jsonLdPeople(document) {
  const people = [];

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(String(script.textContent ?? ''));
    } catch {
      // One malformed block must not cost the page its other blocks.
      continue;
    }

    walk(data, 0);
  }

  /**
   * @param {any} node
   * @param {number} depth
   */
  function walk(node, depth) {
    if (!node || depth > 8 || people.length >= 20) return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    const type = node['@type'];
    const types = Array.isArray(type) ? type.map(String) : [String(type ?? '')];
    if (types.includes('Person')) people.push(node);

    for (const value of Object.values(node)) walk(value, depth + 1);
  }

  return people;
}
