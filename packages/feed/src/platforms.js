/*
 * The identity a publisher never wrote down.
 *
 * `identity.js` reads what a page *says*: rel="me", an h-card, a JSON-LD
 * `sameAs`, a footer link. That works beautifully on the part of the small web
 * that marks itself up, and it finds exactly nothing on the part that does not.
 *
 * The case that made this necessary is the ordinary one. `felginep.github.io`
 * publishes a blog with no rel="me", no h-card, and one outbound link — to the
 * Jekyll theme its author happened to use. The old pass fetched the page,
 * correctly found nobody, and stamped the feed as checked. Meanwhile the
 * author's GitHub account was named *in the hostname the feed was served from*,
 * and the profile behind it confirms his real name.
 *
 * So this module reads two things nobody had to publish:
 *
 * - **The host.** A blog on `<user>.github.io`, `<user>.substack.com` or
 *   `medium.com/@<user>` names its owner's account in the address. That costs
 *   no request at all — it is a fact about the URL we already have.
 * - **The profile behind it.** Given the account, its platform will describe
 *   the person: GitHub returns a real name, a homepage and sometimes a public
 *   email; GitLab returns a name and a public email without a token, and its
 *   contact fields with one; a Mastodon account returns its profile fields
 *   *with the instance's own rel="me" verification already done for us*.
 *
 * **Pure by construction.** Nothing here fetches. The functions describe a
 * request (`profileRequest`) and read a response (`identityFromProfile`), which
 * is the same split `identity.js` keeps and the reason both can be tested
 * without a network. `enrich.js` owns the sockets.
 *
 * **The confidence rule.** A host-derived account is evidence, not proof:
 * `blog.example.com` on a shared host is not a person, and a project site can
 * live under an organisation's `github.io`. So a derivation is only made where
 * the platform gives each *user* their own subdomain, and the account it
 * proposes is confirmed the moment the profile answers with a matching name.
 * Anything unconfirmed stays below the publishing floor.
 */

/**
 * Platforms that put a user's handle in the hostname.
 *
 * Only the ones where a subdomain is *a person's account* rather than a site
 * somebody happens to host. `<user>.wordpress.com` and `<user>.blogspot.com`
 * are deliberately absent: they name a blog, and we already have the blog —
 * deriving "a website link to the feed we are enriching" is a row that teaches
 * nobody anything.
 *
 * `reserved` are the subdomains the platform itself uses, which are never
 * people. Without it, `www.github.io` and `pages.github.com` become authors.
 */
const HOST_ACCOUNTS = [
  {
    network: 'github',
    host: /^([a-z0-9](?:[a-z0-9-]{0,38}))\.github\.io$/i,
    profile: (handle) => `https://github.com/${handle}`,
  },
  {
    network: 'gitlab',
    host: /^([a-z0-9][\w.-]{1,60})\.gitlab\.io$/i,
    profile: (handle) => `https://gitlab.com/${handle}`,
  },
  {
    network: 'codeberg',
    host: /^([a-z0-9][\w-]{0,38})\.codeberg\.page$/i,
    profile: (handle) => `https://codeberg.org/${handle}`,
  },
  {
    network: 'sourcehut',
    host: /^([\w.-]{1,64})\.srht\.site$/i,
    profile: (handle) => `https://git.sr.ht/~${handle}`,
  },
  {
    network: 'substack',
    host: /^([\w-]{1,60})\.substack\.com$/i,
    profile: (handle) => `https://${handle}.substack.com`,
  },
  {
    network: 'medium',
    host: /^([\w-]{1,60})\.medium\.com$/i,
    profile: (handle) => `https://medium.com/@${handle}`,
  },
  {
    network: 'tumblr',
    host: /^([\w-]{1,32})\.tumblr\.com$/i,
    profile: (handle) => `https://${handle}.tumblr.com`,
  },
  {
    network: 'microblog',
    host: /^([\w.-]{1,60})\.micro\.blog$/i,
    profile: (handle) => `https://micro.blog/${handle}`,
  },
  {
    network: 'bearblog',
    host: /^([\w-]{1,60})\.bearblog\.dev$/i,
    profile: (handle) => `https://bearblog.dev/${handle}`,
  },
];

/**
 * Path-shaped platforms, where the handle is the first segment.
 *
 * Same idea as above for hosts that give everybody one domain. Only applied to
 * the *feed's own* address, never to an arbitrary link — `classifyLink` already
 * reads links, and this is about the address the feed itself lives at.
 */
const PATH_ACCOUNTS = [
  { network: 'medium', host: /^(?:www\.)?medium\.com$/i, path: /^\/@([\w.-]{1,60})(?:\/|$)/ },
  { network: 'devto', host: /^dev\.to$/i, path: /^\/([\w-]{1,60})(?:\/|$)/ },
  { network: 'hashnode', host: /^hashnode\.com$/i, path: /^\/@([\w-]{1,60})(?:\/|$)/ },
  { network: 'microblog', host: /^(?:www\.)?micro\.blog$/i, path: /^\/([\w.-]{1,60})(?:\/|$)/ },
  { network: 'substack', host: /^(?:www\.)?substack\.com$/i, path: /^\/@([\w-]{1,60})(?:\/|$)/ },
];

/**
 * Subdomains that belong to the platform rather than to a person.
 *
 * Kept deliberately short. A false *positive* here costs an author page for a
 * person who does not exist, which is the expensive mistake; a false negative
 * costs one blogger a link we would have found on their page anyway.
 */
const RESERVED_HANDLES = new Set([
  'www',
  'blog',
  'docs',
  'help',
  'api',
  'status',
  'about',
  'support',
  'mail',
  'admin',
  'pages',
  'app',
  'static',
  'assets',
  'cdn',
  'media',
  'news',
  'test',
  'demo',
  'example',
]);

/**
 * Accounts named by the addresses a feed already has.
 *
 * Costs no request: this is arithmetic on strings we were given. Both the feed
 * URL and the site URL are read, because they disagree often — a blog on its
 * own domain whose feed is proxied through Substack names its author in the
 * feed URL and nowhere else.
 *
 * @param {...unknown} urls the feed URL, the site URL, in any order
 * @returns {Array<{ network: string, url: string, handle: string, source: string, confidence: number }>}
 */
export function hostIdentity(...urls) {
  /** @type {Map<string, object>} */
  const found = new Map();

  for (const raw of urls) {
    let parsed;
    try {
      parsed = new URL(String(raw ?? ''));
    } catch {
      continue;
    }
    if (!/^https?:$/.test(parsed.protocol)) continue;

    const host = parsed.hostname.toLowerCase();

    for (const rule of HOST_ACCOUNTS) {
      const match = host.match(rule.host);
      if (!match) continue;
      add(found, rule.network, match[1], rule.profile);
      break;
    }

    for (const rule of PATH_ACCOUNTS) {
      if (!rule.host.test(host)) continue;
      const match = parsed.pathname.match(rule.path);
      if (!match) continue;
      add(found, rule.network, match[1], (handle) =>
        rule.network === 'medium'
          ? `https://medium.com/@${handle}`
          : `https://${host}/${rule.network === 'hashnode' || rule.network === 'substack' ? '@' : ''}${handle}`,
      );
      break;
    }
  }

  return [...found.values()];
}

/**
 * @param {Map<string, object>} found
 * @param {string} network
 * @param {string} rawHandle
 * @param {(handle: string) => string} profile
 */
function add(found, network, rawHandle, profile) {
  const handle = String(rawHandle ?? '').toLowerCase();
  if (!handle || RESERVED_HANDLES.has(handle)) return;

  const url = profile(handle);
  const key = `${network}:${handle}`;
  if (found.has(key)) return;

  found.set(key, {
    network,
    url,
    handle,
    source: 'host-derived',
    // Below the 0.6 publishing floor on purpose. The hostname is a strong hint
    // and not a fact: it becomes one when `identityFromProfile` finds a profile
    // that agrees, and that is what raises it.
    confidence: 0.5,
  });
}

/**
 * The platforms that will describe a person if asked, and how to ask.
 *
 * Only APIs that answer unauthenticated, return JSON, and publish a *person*
 * rather than a repository. Bluesky and LinkedIn are absent for the reason they
 * are absent from the rel="me" verification list — one renders client-side and
 * the other refuses robots outright.
 */
const PROFILE_APIS = {
  github: (handle) => `https://api.github.com/users/${encodeURIComponent(handle)}`,
  gitlab: (handle) => `https://gitlab.com/api/v4/users?username=${encodeURIComponent(handle)}`,
  codeberg: (handle) => `https://codeberg.org/api/v1/users/${encodeURIComponent(handle)}`,
};

/**
 * How to ask a platform about one of its people.
 *
 * Returns null for a link no API here can resolve, which is most of them — the
 * caller treats that as "nothing more to learn from this one" rather than as an
 * error.
 *
 * `token` is the caller's GitHub credential, and it matters more than it looks:
 * **the unauthenticated GitHub API allows 60 requests an hour per IP**, which is
 * roughly one enrichment batch. With a token it is 5,000. A pass over this
 * directory without one is not slow, it is stopped.
 *
 * @param {{ network: string, handle?: string, url?: string }} link
 * @param {{ token?: string }} [opts]
 * @returns {{ url: string, network: string, headers: Record<string, string> }|null}
 */
export function profileRequest(link, opts = {}) {
  const network = String(link?.network ?? '');
  const handle = String(link?.handle ?? '').replace(/^[@~]/, '');
  if (!handle) return null;

  // The fediverse has no host list, so its endpoint is derived from the account
  // rather than looked up: `@user@host` is served by `host`.
  if (network === 'fediverse') {
    const parts = handle.replace(/^@/, '').split('@');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return {
      network,
      url: `https://${parts[1]}/api/v1/accounts/lookup?acct=${encodeURIComponent(parts[0])}`,
      headers: { accept: 'application/json' },
    };
  }

  const build = PROFILE_APIS[network];
  if (!build) return null;

  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json' };

  if (network === 'github') {
    headers.accept = 'application/vnd.github+json';
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  }

  return { network, url: build(handle), headers };
}

/**
 * Read a profile document into the credits and links it implies.
 *
 * Each platform is mapped explicitly rather than by a shared field list,
 * because the one field that matters is different on each: GitHub calls the
 * homepage `blog`, GitLab calls it `website_url` and publishes the email as
 * `public_email`, and Mastodon does not have named fields at all — it has an
 * array the user filled in themselves, of which the *verified* entries are
 * worth more than anything else this module can find.
 *
 * `kind` is the one field the caller must not ignore. GitHub and Gitea both
 * serve organisations from the same endpoint as people, so a project site on
 * `someproject.github.io` resolves to an account whose "name" is a product.
 * Turning that into an author row would publish a company as a person, which is
 * the one mistake this directory has been careful not to make since the role
 * filters went in.
 *
 * @param {string} network
 * @param {unknown} body the parsed JSON
 * @param {{ handle?: string, url?: string }} [link] the account this describes
 * @returns {{ name: string, bio: string, avatar: string, kind: string, links: Array<object> }}
 */
export function identityFromProfile(network, body, link = {}) {
  const empty = { name: '', bio: '', avatar: '', kind: 'unknown', links: [] };
  if (!body || typeof body !== 'object') return empty;

  switch (network) {
    case 'github':
      return fromGithub(/** @type {any} */ (body));
    case 'gitlab':
      // The users endpoint answers with an array, because it is a search.
      return fromGitlab(Array.isArray(body) ? body[0] : body);
    case 'codeberg':
      return fromCodeberg(/** @type {any} */ (body));
    case 'fediverse':
      return fromMastodon(/** @type {any} */ (body), link);
    default:
      return empty;
  }
}

/**
 * GitHub.
 *
 * `email` is only ever populated when the account holder ticked the box that
 * publishes it, so it is a contact address they chose to make public rather
 * than one scraped out of commit metadata — which is a different thing with
 * different rules, and is not collected here.
 *
 * @param {any} p
 */
function fromGithub(p) {
  const links = [];
  if (p.blog) links.push(profileLink('website', p.blog, 'github-profile'));
  if (p.email) links.push(profileLink('email', `mailto:${p.email}`, 'github-profile'));
  if (p.twitter_username) {
    links.push(profileLink('twitter', `https://x.com/${p.twitter_username}`, 'github-profile'));
  }

  return {
    name: str(p.name),
    bio: str(p.bio),
    avatar: str(p.avatar_url),
    // "User" or "Organization"; anything else is a shape we do not know and is
    // treated as unknown rather than assumed to be a person.
    kind: p.type === 'Organization' ? 'org' : p.type === 'User' ? 'user' : 'unknown',
    links: links.filter(Boolean),
  };
}

/**
 * GitLab.
 *
 * Measured rather than assumed: the *unauthenticated* `/users?username=` search
 * answers a reduced object — `name`, `public_email`, `avatar_url`, `web_url`
 * and nothing else. The richer profile (`website_url`, `bio`, `twitter`,
 * `linkedin`) needs a token, and `/users/:id` refuses outright without one. The
 * mappings below cover both shapes, so a deployment that sets a GitLab token
 * gets the contact fields and one that does not still gets a name and a public
 * email, which is the part that matters.
 *
 * @param {any} p
 */
function fromGitlab(p) {
  if (!p || typeof p !== 'object') return { name: '', bio: '', avatar: '', kind: 'unknown', links: [] };

  const links = [];
  if (p.website_url) links.push(profileLink('website', p.website_url, 'gitlab-profile'));
  if (p.public_email) links.push(profileLink('email', `mailto:${p.public_email}`, 'gitlab-profile'));
  if (p.twitter) links.push(profileLink('twitter', `https://x.com/${strip(p.twitter)}`, 'gitlab-profile'));
  if (p.linkedin) {
    links.push(profileLink('linkedin', `https://www.linkedin.com/in/${strip(p.linkedin)}`, 'gitlab-profile'));
  }

  return {
    name: str(p.name),
    bio: str(p.bio),
    avatar: str(p.avatar_url),
    // GitLab groups are not returned by the user search at all, so anything
    // that answers here is a user account.
    kind: 'user',
    links: links.filter(Boolean),
  };
}

/**
 * Codeberg, which runs Gitea and answers the same shape.
 *
 * @param {any} p
 */
function fromCodeberg(p) {
  const links = [];
  if (p.website) links.push(profileLink('website', p.website, 'codeberg-profile'));
  if (p.email) links.push(profileLink('email', `mailto:${p.email}`, 'codeberg-profile'));

  return {
    name: str(p.full_name),
    bio: str(p.description),
    avatar: str(p.avatar_url),
    // Gitea marks organisations with a user_type of 1.
    kind: Number(p.user_type) === 1 ? 'org' : 'user',
    links: links.filter(Boolean),
  };
}

/**
 * A fediverse account, and the best source in this module.
 *
 * Mastodon's profile `fields` are free-form rows the account holder wrote, and
 * an entry carries `verified_at` when the instance followed the link and found
 * a rel="me" pointing back. That is the IndieWeb handshake **already performed
 * by somebody else** — the same proof `enrichFeedAuthors` spends up to three
 * fetches on, arriving for free with the profile.
 *
 * So a verified field is marked `verified` and nothing else here is.
 *
 * @param {any} p
 * @param {{ url?: string }} link
 */
function fromMastodon(p, link) {
  const links = [];

  for (const field of Array.isArray(p.fields) ? p.fields : []) {
    // The value is HTML — Mastodon renders the link itself — so the href is
    // what to read, falling back to the text for an entry typed as bare text.
    const href = String(field?.value ?? '').match(/href="([^"]+)"/)?.[1] ?? String(field?.value ?? '');
    const url = href.replace(/<[^>]*>/g, '').trim();
    if (!url) continue;

    links.push({
      url,
      source: 'fediverse-profile',
      verified: Boolean(field?.verified_at),
      // A field the instance proved is as good as evidence gets short of the
      // person telling us themselves.
      confidence: field?.verified_at ? 0.95 : 0.5,
    });
  }

  if (p.url && !links.some((l) => l.url === p.url)) {
    links.push({ url: String(p.url), source: 'fediverse-profile', verified: false, confidence: 0.6 });
  }

  return {
    name: str(p.display_name),
    kind: p.group ? 'org' : 'user',
    // The bio is HTML on this platform and prose everywhere else.
    bio: plain(p.note),
    avatar: str(p.avatar_static || p.avatar),
    links,
  };
}

/**
 * @param {string} network
 * @param {unknown} url
 * @param {string} source
 */
function profileLink(network, url, source) {
  const value = str(url);
  if (!value) return null;
  return {
    network,
    // A platform field is frequently typed without a scheme ("example.com"),
    // which is not a URL until it has one.
    url: /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`,
    source,
    verified: false,
    // Published by the person on an account we already believe is theirs, which
    // is above the floor but short of a proved backlink.
    confidence: 0.8,
  };
}

/**
 * HTML as the prose it was written as.
 *
 * Only the fediverse needs this — its bio field is rendered markup rather than
 * text. Which tags become a space and which vanish is the whole job: replacing
 * *every* tag with a space turns "<b>InfoSec</b>." into "InfoSec ." (the test
 * that found this was right to), while replacing every tag with nothing joins
 * two paragraphs into one word. So the block-level tags separate and the inline
 * ones close up, which is what they mean.
 *
 * Entities are decoded too, because a bio is displayed to a reader and
 * "Tom &amp; Jerry" is not what anyone wrote.
 *
 * @param {unknown} html
 * @returns {string}
 */
function plain(html) {
  return String(html ?? '')
    .replace(/<\/(?:p|div|li|h[1-6])>|<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/gi, (_, name) => {
      const map = {
        nbsp: ' ',
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        '#39': "'",
        apos: "'",
      };
      return map[String(name).toLowerCase()] ?? _;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {unknown} v */
function str(v) {
  return v == null ? '' : String(v).trim();
}

/** @param {unknown} v handle fields that arrive with an @ or a full URL */
function strip(v) {
  return String(v ?? '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/[^/]+\/(?:in\/)?/i, '')
    .replace(/\/+$/, '');
}
