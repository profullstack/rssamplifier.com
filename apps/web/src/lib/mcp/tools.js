import { q, newId, authors as people } from '@rssamplifier/db';
import { topicSlug } from '@rssamplifier/feed';
import { submitCatalogue, hashIp } from '@rssamplifier/ingest';

import { db, siteUrl } from '../db.js';
import { readerView } from '../reader.js';
import { RAW_INPUT_LIMIT } from '../submitted.js';
import { clip, plainText } from './text.js';

/**
 * What an agent can do with the directory.
 *
 * These are the JSON API's capabilities with the HTTP taken off: same queries,
 * same numbers, described rather than documented. The descriptions are the
 * interface — a model picks a tool by reading them and nothing else — so they
 * say what the tool answers and, where it matters, what it costs.
 *
 * Every read here is one the site already serves publicly and anonymously, so
 * no tool needs a key. The one write, `submit_feed`, carries the same per-IP
 * rate limit as the form.
 */

/** How much extracted article text one `read_post` call may return. */
const ARTICLE_LIMIT = 24_000;

/** Feeds one `submit_feed` call will resolve before queueing the rest. */
const SUBMIT_INLINE_LIMIT = 20;

/** Submissions allowed per IP per hour, matching /api/submit. */
const SUBMIT_RATE_LIMIT = 20;

/**
 * @typedef {object} ToolContext
 * @property {(name: string) => string|null} header reads one HTTP request header
 */

/**
 * @typedef {object} Tool
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {object} inputSchema
 * @property {object} annotations
 * @property {(args: any, ctx: ToolContext) => Promise<unknown>} run
 */

/** @type {Tool[]} */
export const TOOLS = [
  {
    name: 'search',
    title: 'Search the directory',
    description:
      'Full-text search across every post and blog in the directory. Returns matching blogs and matching individual posts, each with the identifiers read_post needs. Use mode="any" to match any one of the terms rather than all of them — useful when a thing goes by several names.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        mode: {
          type: 'string',
          enum: ['all', 'any'],
          description: 'Require every term (default) or any one of them.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Results of each kind. Default 30.',
        },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args) {
      const query = String(args?.query ?? '').trim();
      if (!query) throw invalid('query is required');

      const mode = args?.mode === 'any' ? 'any' : 'all';
      const limit = bounded(args?.limit, 30, 1, 100);
      const client = db();

      const [blogs, posts] = await Promise.all([
        q.searchFeeds(client, query, limit, mode),
        q.searchItems(client, query, limit, mode),
      ]);

      return {
        query,
        mode,
        blogs: blogs.map((b) => ({
          slug: b.slug,
          title: b.title,
          description: b.description,
          page: `${siteUrl()}/${b.slug}`,
        })),
        posts: posts.map(post),
      };
    },
  },

  {
    name: 'list_feeds',
    title: 'List feeds',
    description:
      'Page through the whole directory, newest first. Narrow to one category with kind: blog, news, podcast, music, video, comic, live or reel. The category is decided from the feed document on every crawl, never from what the submitter claimed.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: q.KINDS,
          description: 'Only feeds of this category. Omit for all of them.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
        offset: { type: 'integer', minimum: 0, description: 'Default 0.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args) {
      const kind = q.normalizeKind(args?.kind);
      const limit = bounded(args?.limit, 50, 1, 200);
      const offset = Math.max(Number(args?.offset ?? 0) || 0, 0);
      const client = db();

      const [rows, total] = await Promise.all([
        q.listFeeds(client, { limit, offset, kind }),
        q.countFeeds(client, false, kind),
      ]);

      return {
        total,
        limit,
        offset,
        kind,
        kinds: q.KINDS,
        feeds: rows.map(feed),
      };
    },
  },

  {
    name: 'get_feed',
    title: 'Get one feed',
    description:
      "One blog or podcast: its metadata, who writes it, where it can be found elsewhere, the topics it is filed under — including the ones no other feed shares — and its recent posts. `authors` is people; `links` is the blog's own accounts, which is what an unsigned blog has instead. Each post carries the feed slug and guid that read_post takes. Use the slug from search or list_feeds, not the site's own URL.",
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: "The feed's slug in this directory." },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Posts. Default 50.' },
      },
      required: ['slug'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args) {
      const slug = String(args?.slug ?? '').trim();
      if (!slug) throw invalid('slug is required');

      const client = db();
      const found = await q.feedBySlug(client, slug);
      if (!found) throw invalid(`no feed with slug '${slug}'`);

      const limit = bounded(args?.limit, 50, 1, 200);
      const [items, topics, credited, feedLinks] = await Promise.all([
        q.itemsForFeed(client, String(found.id), limit),
        q.keywordsForFeed(client, String(found.id), 25),
        people.authorsForFeed(client, String(found.id)),
        people.linksForFeed(client, String(found.id)),
      ]);

      return {
        ...feed(found),
        authors: credited.map(author),
        // Where the blog itself is, whoever writes it. On a blog with no
        // byline these are the only way to reach anybody, and roughly a third
        // of the small web publishes accounts without publishing a name.
        links: feedLinks,
        topics: topics.map((t) => ({
          slug: t.slug,
          keyword: t.keyword,
          // 'category' is the publisher's own tag; 'content' is a phrase
          // counted across the feed's writing.
          source: t.source,
          strength: Number(t.count ?? 0),
        })),
        posts: items.map((i) => post({ ...i, feed_slug: found.slug, feed_title: found.title })),
      };
    },
  },

  {
    name: 'list_topics',
    title: 'List topics',
    description:
      'What the directory covers, by how many feeds cover it. Pass query to search the index instead of paging it. Only subjects at least two feeds share are indexed — a topic one blog uses is that blog\'s own vocabulary, and lives on its page instead. Raise min to find the well-covered subjects.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search the topic index. A phrase works as well as a slug — "quantum physics" and "quantum-physics" are the same search. Matches are ranked: the exact topic, then topics starting with the term, then topics containing it.',
        },
        min: {
          type: 'integer',
          minimum: 2,
          maximum: 100,
          description: 'Only topics at least this many feeds cover. Default 2.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 100.' },
        offset: { type: 'integer', minimum: 0, description: 'Default 0.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args) {
      const minFeeds = bounded(args?.min, 2, 2, 100);
      const limit = bounded(args?.limit, 100, 1, 500);
      const offset = Math.max(Number(args?.offset ?? 0) || 0, 0);
      const query = typeof args?.query === 'string' ? args.query.trim() || null : null;
      const client = db();

      const [rows, total] = await Promise.all([
        q.listTopics(client, { limit, offset, minFeeds, query }),
        q.countTopics(client, minFeeds, query),
      ]);

      return {
        total,
        query,
        limit,
        offset,
        min: minFeeds,
        topics: rows.map((t) => ({
          slug: t.slug,
          keyword: t.keyword,
          feedCount: Number(t.feed_count ?? 0),
          page: `${siteUrl()}/topics/${encodeURIComponent(String(t.slug))}`,
          // The subscription list, so an agent that found a subject can hand
          // the feeds to a reader without a second round trip.
          opml: `${siteUrl()}/opml?topic=${encodeURIComponent(String(t.slug))}`,
        })),
      };
    },
  },

  {
    name: 'get_topic',
    title: 'Feeds covering a topic',
    description:
      'Every feed filed under one topic. The keyword is normalised, so "Home Lab", "home lab" and "home-lab" all reach the same topic and you can pass a phrase you read anywhere. Each feed says whether it landed here from the publisher\'s own tag or from a phrase counted across its writing.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'The topic, in any spelling.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 100.' },
        offset: { type: 'integer', minimum: 0, description: 'Default 0.' },
      },
      required: ['keyword'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args) {
      const slug = topicSlug(String(args?.keyword ?? ''));
      if (!slug) throw invalid('keyword is required');

      const client = db();
      const topic = await q.topicBySlug(client, slug);
      if (!topic) throw invalid(`no topic '${args?.keyword}' — try list_topics or search`);

      const limit = bounded(args?.limit, 100, 1, 500);
      const offset = Math.max(Number(args?.offset ?? 0) || 0, 0);
      const rows = await q.feedsForTopic(client, slug, { limit, offset });

      return {
        slug: topic.slug,
        keyword: topic.keyword,
        total: topic.feedCount,
        limit,
        offset,
        page: `${siteUrl()}/topics/${encodeURIComponent(topic.slug)}`,
        feeds: rows.map((f) => ({
          ...feed(f),
          source: f.source,
          strength: Number(f.count ?? 0),
        })),
      };
    },
  },

  {
    name: 'topic_posts',
    title: 'Recent posts on a topic',
    description:
      'What the feeds covering a topic have actually published lately, newest first — the river rather than the roster. Note the difference from get_topic, which lists who covers the subject; this lists what they wrote. Drawn from the feeds most strongly filed under the topic, so a very broad keyword is a sample rather than a census.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'The topic, in any spelling.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
      },
      required: ['keyword'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args) {
      const slug = topicSlug(String(args?.keyword ?? ''));
      if (!slug) throw invalid('keyword is required');

      const client = db();
      const topic = await q.topicBySlug(client, slug);
      if (!topic) throw invalid(`no topic '${args?.keyword}' — try list_topics or search`);

      const limit = bounded(args?.limit, 50, 1, 200);
      const rows = await q.itemsForTopic(client, slug, { limit });

      return {
        slug: topic.slug,
        keyword: topic.keyword,
        limit,
        feed: `${siteUrl()}/topics/${encodeURIComponent(topic.slug)}.rss`,
        posts: rows.map(post),
      };
    },
  },

  {
    name: 'read_post',
    title: 'Read a post',
    description:
      "The full text of one post, extracted from the publisher's own page and returned as prose. Takes the feed slug and post guid that search, get_feed and topic_posts return. The first reader pays for the fetch and everyone after them reads it out of the database, so the publisher is asked once rather than once per view. A post behind a paywall, or on a site that is down, comes back with the feed's summary and a reason instead — never an error.",
    inputSchema: {
      type: 'object',
      properties: {
        feed: { type: 'string', description: "The feed's slug." },
        guid: { type: 'string', description: "The post's guid, as returned by the other tools." },
      },
      required: ['feed', 'guid'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args) {
      const slug = String(args?.feed ?? '').trim();
      const guid = String(args?.guid ?? '').trim();
      if (!slug || !guid) throw invalid('feed and guid are both required');

      const client = db();
      const found = await q.feedBySlug(client, slug);
      if (!found) throw invalid(`no feed with slug '${slug}'`);

      const item = await q.itemByGuid(client, String(found.id), guid);
      if (!item) throw invalid(`no post with guid '${guid}' in '${slug}'`);

      const view = await readerView({ itemId: String(item.id), url: item.url ?? null });
      const body = clip(plainText(view.article?.html ?? ''), ARTICLE_LIMIT);

      return {
        ...post({ ...item, feed_slug: found.slug, feed_title: found.title }),
        // Why the text is or is not here, in the reader's own vocabulary:
        // 'extracted' means we read the page, 'frameable' means the publisher
        // allows embedding and we did not need to, and anything else is the
        // refusal or failure that stopped us.
        reason: view.reason,
        byline: view.article?.byline ?? null,
        siteName: view.article?.siteName ?? null,
        text: body.text || null,
        truncated: body.truncated,
      };
    },
  },

  {
    name: 'random_feed',
    title: 'A blog at random',
    description:
      'One feed from the directory, chosen at random, with its recent posts. The web without a ranking function: what is here rather than what is popular.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run() {
      const client = db();
      const slug = await q.randomSlug(client);
      if (!slug) throw invalid('the directory is empty');

      const found = await q.feedBySlug(client, String(slug));
      const items = await q.itemsForFeed(client, String(found.id), 10);

      return {
        ...feed(found),
        posts: items.map((i) => post({ ...i, feed_slug: found.slug, feed_title: found.title })),
      };
    },
  },

  {
    name: 'list_authors',
    title: 'List the people behind the feeds',
    description:
      "The directory's authors and where else they publish — their own sites, Mastodon and Bluesky accounts, GitHub, links pages. Every link was published by the author on their own site as a rel=\"me\" claim, an h-card or JSON-LD; nothing is scraped from a platform or bought. Filter with network to find only people reachable a given way (email, fediverse, bluesky, github, website, linktree), or query to search names. Role mailboxes like info@ are never returned: they are dropped at extraction, so an address here belongs to a person.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search names.' },
        network: {
          type: 'string',
          description: 'Only people with a link on this network, e.g. "email" or "fediverse".',
        },
        minConfidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'How sure the attribution must be, 0 to 1. Default 0.6, which is what the site itself publishes. Lower it for the long tail, and expect some of it to be wrong.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
        offset: { type: 'integer', minimum: 0, description: 'Default 0.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args) {
      const client = db();
      const limit = bounded(args?.limit, 50, 1, 200);
      const offset = Math.max(Number(args?.offset ?? 0) || 0, 0);
      const minConfidence = boundedFloat(args?.minConfidence, 0.6, 0, 1);

      const [rows, stats] = await Promise.all([
        people.listAuthors(client, {
          limit,
          offset,
          minConfidence,
          network: String(args?.network ?? '').trim(),
          query: String(args?.query ?? '').trim(),
        }),
        people.authorStats(client, { minConfidence }),
      ]);

      return {
        // Said up front, because the honest answer to "who writes the small
        // web" is that we know for a fraction of it so far and the pass is
        // still walking. A count without that context reads as the whole.
        known: stats.authors,
        reachable: stats.reachable,
        feedsChecked: stats.feedsChecked,
        // Blogs with an account but no byline. Their links are on the feed,
        // via get_feed, because there is no person to file them under.
        feedsWithLinks: stats.feedsWithLinks,
        authors: rows.map(author),
      };
    },
  },

  {
    name: 'get_author',
    title: 'Get one author',
    description:
      'One person: where to find them, and everything in the directory they publish. The feed list is what settles whether two people with the same name are the same person.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: "The author's slug in this directory." },
      },
      required: ['slug'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args) {
      const slug = String(args?.slug ?? '').trim();
      if (!slug) throw invalid('slug is required');

      const found = await people.authorBySlug(db(), slug);
      if (!found) throw invalid(`no author with slug '${slug}'`);

      return {
        ...author(found),
        feeds: (found.feeds ?? []).map((f) => ({
          slug: f.slug,
          title: f.title,
          kind: f.kind,
          // 'owner' publishes it; 'author' writes in it.
          role: f.role,
          itemCount: Number(f.item_count ?? 0),
          page: `${siteUrl()}/${f.slug}`,
        })),
      };
    },
  },

  {
    name: 'directory_stats',
    title: 'Directory and crawler status',
    description:
      'How big the directory is, what it is made of, and whether the crawler is keeping up. `stale` is active feeds not read successfully in a day; `due` is a backlog that should drain within a tick or two. Answer this before concluding a feed is missing — it may simply not have been crawled yet.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run() {
      const client = db();
      const [stats, kinds] = await Promise.all([q.crawlStats(client), q.countFeedsByKind(client)]);
      return { ...stats, byKind: kinds };
    },
  },

  {
    name: 'submit_feed',
    title: 'Add a feed to the directory',
    description:
      'Submit one URL or a list of them. A site URL works as well as a feed URL — the feed is discovered from the page. Anyone may submit; there is no account and no review queue. Feeds resolve inline up to a handful and the rest are queued for the crawler, so the answer says which. Rate limited per caller.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Feed or site URLs. One is fine.',
          maxItems: 200,
        },
      },
      required: ['urls'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(args, ctx) {
      const urls = (Array.isArray(args?.urls) ? args.urls : [args?.urls])
        .map((u) => String(u ?? '').trim())
        .filter(Boolean);

      if (urls.length === 0) throw invalid('urls is required');

      const client = db();

      // Same per-IP ledger the form writes to, so an agent and a browser share
      // one budget rather than the agent having a private one.
      const ip =
        ctx.header('x-forwarded-for')?.split(',')[0]?.trim() || ctx.header('x-real-ip') || null;
      const ipHash = hashIp(ip, process.env['IP_HASH_SALT']);

      if (ipHash && (await q.submissionCount(client, ipHash)) >= SUBMIT_RATE_LIMIT) {
        throw invalid('rate limited — try again in an hour');
      }

      const submissionId = newId();
      await q.insertSubmission(client, {
        id: submissionId,
        kind: urls.length > 1 ? 'list' : 'url',
        raw_input: urls.join('\n').slice(0, RAW_INPUT_LIMIT),
        ip_hash: ipHash,
        user_agent: ctx.header('user-agent')?.slice(0, 300) ?? null,
      });

      const result = await submitCatalogue(
        client,
        urls.map((url) => ({ url })),
        { submissionId, inlineLimit: SUBMIT_INLINE_LIMIT },
      );

      await q.completeSubmission(client, submissionId, {
        accepted_count: result.accepted.length,
        rejected_count: result.rejected.length,
        queued_count: result.queued,
        notify_email: null,
        errors: result.rejected,
      });

      return {
        ok: result.accepted.length > 0 || result.queued > 0,
        accepted: result.accepted.map((a) => ({
          slug: a.slug,
          existing: a.existing,
          page: `${siteUrl()}/${a.slug}`,
        })),
        rejected: result.rejected,
        queued: result.queued,
        total: result.total,
        statusUrl: `${siteUrl()}/submissions/${submissionId}`,
      };
    },
  },
];

/** @type {Map<string, Tool>} */
export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * A tool as `tools/list` describes it.
 *
 * @param {Tool} tool
 * @returns {object}
 */
export function describe(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { title: tool.title, ...tool.annotations },
  };
}

/**
 * A feed row, in the shape every tool returns it.
 *
 * @param {any} f
 * @returns {object}
 */
function feed(f) {
  return {
    slug: f.slug,
    title: f.title,
    description: f.description,
    siteUrl: f.site_url,
    feedUrl: f.feed_url,
    language: f.language,
    kind: f.category,
    itemCount: f.item_count,
    status: f.status,
    lastSuccessAt: f.last_success_at,
    page: `${siteUrl()}/${f.slug}`,
  };
}

/**
 * An author row, in the shape every tool returns it.
 *
 * `source` and `confidence` ride along rather than being flattened away
 * because the caller is usually deciding whether to act on this — and "we read
 * it off a rel=me link on their own site" and "we saw the icon in a footer"
 * are not the same claim, however similar the two rows look.
 *
 * @param {any} a
 * @returns {object}
 */
function author(a) {
  return {
    slug: a.slug,
    name: a.name,
    bio: a.bio,
    site: a.site_url,
    email: a.email,
    role: a.role,
    confidence: Number(a.confidence ?? 0),
    page: `${siteUrl()}/authors/${a.slug}`,
    links: (a.links ?? []).map((l) => ({
      network: l.network,
      url: l.url,
      handle: l.handle,
      source: l.source,
      verified: l.verified,
    })),
  };
}

/**
 * A post row, in the shape every tool returns it.
 *
 * `feed` and `guid` travel together on purpose: they are exactly the pair
 * `read_post` takes, so an agent never has to construct an identifier or parse
 * one out of a URL.
 *
 * @param {any} i
 * @returns {object}
 */
function post(i) {
  return {
    title: i.title,
    url: i.url,
    summary: i.summary,
    author: i.author,
    publishedAt: i.published_at,
    feed: i.feed_slug,
    feedTitle: i.feed_title,
    guid: i.guid,
    audioUrl: i.audio_url ?? null,
    // What the publisher declared as the post's picture. An agent building a
    // page out of these answers has no other way to get one, and the field is
    // null far less often than it used to be.
    imageUrl: i.image_url ?? null,
  };
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function bounded(raw, fallback, min, max) {
  const n = Number(raw ?? fallback) || fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * The same, for an argument that is a fraction rather than a count.
 *
 * `bounded` truncates, which is right for a limit and wrong for a confidence:
 * it would quietly turn 0.6 into 0 and hand back the whole long tail to a
 * caller who asked for the opposite.
 *
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function boundedFloat(raw, fallback, min, max) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * A failure the caller can fix, as opposed to one we should be told about.
 *
 * Thrown rather than returned so that a handler reads as a straight line; the
 * dispatcher turns it into a tool result with `isError`, which is what the
 * protocol wants for "the tool ran and could not do it" — a JSON-RPC error is
 * reserved for "the tool could not be run at all".
 *
 * @param {string} message
 * @returns {Error & { toolError?: true }}
 */
function invalid(message) {
  const err = /** @type {Error & { toolError?: true }} */ (new Error(message));
  err.toolError = true;
  return err;
}
