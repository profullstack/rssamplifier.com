/**
 * What an alert says, in each of the three shapes it has to say it.
 *
 * Kept apart from the sending so it can be read and tested as text: an email is
 * a digest, a push notification is one line on a lock screen, and a webhook is
 * a document for a program. They are the same facts wearing different amounts of
 * clothing, and the differences between them are decisions worth seeing in one
 * file.
 */

/**
 * The site's own address, for links inside a message nobody is reading on it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function siteOrigin(env = process.env) {
  return (env['SITE_URL'] || 'https://rssamplifier.com').replace(/\/+$/, '');
}

/**
 * One alerted post, flattened to the fields every channel needs.
 *
 * `via` is the follow that pulled it in, the same idea the river carries: an
 * alert that says only "new post" leaves the reader working out which of their
 * forty follows it came from, and the answer is already in hand here.
 *
 * @param {object} row
 * @param {{ kind: string, title: string, href: string }} via
 * @param {string} [origin]
 * @returns {{
 *   title: string, url: string, summary: string, publishedAt: string|null,
 *   feed: { slug: string, title: string, url: string },
 *   via: { kind: string, title: string, url: string },
 * }}
 */
export function alertItem(row, via, origin = siteOrigin()) {
  const feedSlug = String(row.feed_slug ?? '');

  return {
    title: String(row.title ?? 'Untitled'),
    // The publisher's own URL, not ours. An alert is an invitation to go and
    // read the thing, and bouncing it through the directory first would be the
    // directory putting itself in front of the writing it exists to point at.
    url: String(row.url ?? ''),
    summary: trim(String(row.summary ?? ''), 300),
    publishedAt: row.published_at ? String(row.published_at) : null,
    feed: {
      slug: feedSlug,
      title: String(row.feed_title ?? feedSlug),
      url: `${origin}/${feedSlug}`,
    },
    via: {
      kind: via.kind,
      title: via.title || String(row.feed_title ?? feedSlug),
      url: via.href ? `${origin}${via.href}` : `${origin}/${feedSlug}`,
    },
  };
}

/**
 * Cut a string to length on a word boundary, with an ellipsis if anything went.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function trim(text, max) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;

  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The digest email.
 *
 * Plain text, like every other message the site sends. One block per post: what
 * it is called, where it came from, where to read it, and a line of the opening
 * — enough to decide without opening, which is the whole job of a digest.
 *
 * @param {ReturnType<typeof alertItem>[]} items
 * @param {{ origin?: string }} [opts]
 * @returns {{ subject: string, text: string }}
 */
export function renderEmail(items, opts = {}) {
  const origin = opts.origin ?? siteOrigin();
  const first = items[0];

  // The subject is the alert. A reader scanning an inbox on a phone sees this
  // and nothing else, so it names the post when there is one and counts them
  // when there are several.
  const subject =
    items.length === 1
      ? `${first.title} — ${first.feed.title}`
      : `${items.length} new posts from what you follow`;

  const blocks = items.map((item) => {
    const lines = [item.title, `  ${item.feed.title}${viaSuffix(item)}`];
    if (item.summary) lines.push(`  ${item.summary}`);
    if (item.url) lines.push(`  ${item.url}`);
    return lines.join('\n');
  });

  const text = [
    items.length === 1
      ? 'A blog you follow has published something.'
      : `${items.length} new posts from the blogs and topics you follow.`,
    '',
    blocks.join('\n\n'),
    '',
    '—',
    `Your river: ${origin}/following`,
    `Turn these off: ${origin}/account/alerts`,
  ].join('\n');

  return { subject, text };
}

/**
 * How a post says which follow brought it, when that is not simply its blog.
 *
 * A followed blog needs no suffix: the post is already attributed to it, and
 * "via" the thing it plainly came from reads as noise. A topic and a person
 * both do need one, because in either case the reason it arrived is not the
 * publication printed beside it. Following someone who writes in four places is
 * the whole point of an author follow, so the name is the part that explains
 * the alert.
 *
 * @param {ReturnType<typeof alertItem>} item
 * @returns {string}
 */
function viaSuffix(item) {
  const { kind, title } = item.via;
  if (!title) return '';
  return kind === 'topic' || kind === 'author' ? ` · via ${title}` : '';
}

/**
 * The push notification.
 *
 * One notification per batch rather than one per post, which is the difference
 * between an alert and a punishment: a topic like "ai" can produce a dozen posts
 * in a quiet hour, and twelve separate notifications for it is how somebody
 * turns alerts off for good.
 *
 * The tag makes replacement the default too — a second batch arriving before the
 * first was read collapses onto it rather than stacking.
 *
 * @param {ReturnType<typeof alertItem>[]} items
 * @param {{ origin?: string }} [opts]
 * @returns {{ title: string, body: string, url: string, tag: string, count: number }}
 */
export function renderPush(items, opts = {}) {
  const origin = opts.origin ?? siteOrigin();

  if (items.length === 1) {
    const item = items[0];
    return {
      title: item.title,
      body: `${item.feed.title}${viaSuffix(item)}`,
      // Straight to the post. A notification about one thing that lands on a
      // list of things is a notification that wasted the tap.
      url: item.url || item.feed.url,
      tag: 'rssamplifier-alert',
      count: 1,
    };
  }

  return {
    title: `${items.length} new posts`,
    // The first few names, because "12 new posts" is not enough to decide
    // whether to look now.
    body: trim(items.map((item) => item.title).join(' · '), 160),
    url: `${origin}/following`,
    tag: 'rssamplifier-alert',
    count: items.length,
  };
}

/**
 * The webhook body.
 *
 * Versioned, because this one has a consumer that is a program rather than a
 * person: a receiver written today should be able to tell that a field it does
 * not recognise is an addition rather than a different message entirely.
 *
 * @param {ReturnType<typeof alertItem>[]} items
 * @param {{ origin?: string, at?: string }} [opts]
 * @returns {object}
 */
export function renderWebhook(items, opts = {}) {
  const origin = opts.origin ?? siteOrigin();

  return {
    version: 1,
    type: 'alert',
    at: opts.at ?? new Date().toISOString(),
    river: `${origin}/following`,
    count: items.length,
    items,
  };
}
