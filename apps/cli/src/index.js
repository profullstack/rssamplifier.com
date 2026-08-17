#!/usr/bin/env node
/**
 * rssamplifier CLI.
 *
 * Talks to the public HTTP API rather than the database, so it needs no
 * credentials and works against any deployment — including a local one via
 * `--api http://localhost:3000`.
 *
 * Zero dependencies: argument parsing and output formatting are small enough to
 * own, and a CLI people install globally should not drag a tree behind it.
 *
 * One file, deliberately. The installer at /install.sh downloads this exact
 * source and drops it on PATH — no build step, no tarball, no npm. That only
 * works while everything the program needs is in here, so this file imports
 * nothing but node: builtins, and does so lazily where it can.
 *
 * It is both a module and a program: the tests import {@link run}, and the
 * shebang plus the guard at the bottom make the same file executable.
 */

import { pathToFileURL } from 'node:url';

export const VERSION = '0.2.0';

const DEFAULT_API = 'https://rssamplifier.com';

/**
 * Every command, in the order they are worth learning.
 *
 * This array is the single source of truth: `--help` is rendered from it, and
 * so is the table on /cli. A command documented in one place and not the other
 * is therefore impossible, which is the same trick the MCP page plays with its
 * tool list.
 *
 * @typedef {{ name: string, usage: string, summary: string, detail: string,
 *   options?: string[], examples?: string[] }} Command
 * @type {Command[]}
 */
export const COMMANDS = [
  {
    name: 'search',
    usage: 'search <query>',
    summary: 'Search every indexed post and blog',
    detail:
      'Full-text search across the directory. Returns matching blogs and matching posts, with a reader URL for each post so you can read it without leaving the site.',
    options: ['--limit <n>', '--json'],
    examples: ['rssamp search "agentic coding"', 'rssamp search homelab --limit 5 --json'],
  },
  {
    name: 'topics',
    usage: 'topics [query]',
    summary: 'Find subjects the directory covers',
    detail:
      'The topic index, ranked by how many feeds cover each subject. With a query it searches that index — exact match first, then subjects starting with the term, then subjects containing it. This is the command to reach for first: a topic is how you get from "I want to read about X" to a list of feeds worth subscribing to.',
    options: ['--limit <n>', '--min <n>', '--json'],
    examples: ['rssamp topics homelab', 'rssamp topics --min 50 --limit 40'],
  },
  {
    name: 'topic',
    usage: 'topic <keyword>',
    summary: 'The feeds filed under one subject',
    detail:
      "Every feed on a topic, strongest first — a publisher's own category outranks a phrase counted out of its writing. The keyword is normalised the way the site normalises it, so \"Home Lab\", \"home-lab\" and \"homelab\" all land on the same topic.",
    options: ['--limit <n>', '--group <name>', '--json'],
    examples: ['rssamp topic homelab', 'rssamp topic physics --group podcasts'],
  },
  {
    name: 'urls',
    usage: 'urls',
    summary: 'One feed URL per line',
    detail:
      'The plainest possible output: feed URLs, one to a line, ready to pipe into another tool. Takes the same filters as `opml`, so `--topic` is the useful form — the whole directory is fifty thousand lines and almost never what you want.',
    options: ['--topic <keyword>', '--kind <kind>', '--limit <n>'],
    examples: ['rssamp urls --topic homelab', 'rssamp urls --kind podcast --limit 100'],
  },
  {
    name: 'opml',
    usage: 'opml [> feeds.opml]',
    summary: 'Export a subscription list',
    detail:
      'An OPML subscription list any feed reader can import. Unfiltered it is the entire directory, which is a large file and a strange thing to subscribe to; `--topic` is the cut most people want.',
    options: ['--topic <keyword>', '--kind <kind>', '--limit <n>'],
    examples: ['rssamp opml --topic homelab > homelab.opml', 'rssamp opml --kind podcast'],
  },
  {
    name: 'list',
    usage: 'list',
    summary: 'Browse the directory, newest first',
    detail: 'The directory itself, most recently added first, with a total at the top.',
    options: ['--limit <n>', '--offset <n>', '--kind <kind>', '--json'],
    examples: ['rssamp list --limit 20', 'rssamp list --kind video'],
  },
  {
    name: 'show',
    usage: 'show <slug>',
    summary: 'One blog and its recent posts',
    detail:
      'Everything the directory knows about one feed: where it lives, how many posts it has, what it was last seen publishing.',
    options: ['--json'],
    examples: ['rssamp show technotim-live'],
  },
  {
    name: 'submit',
    usage: 'submit <url|file.opml> …',
    summary: 'Add blogs to the directory',
    detail:
      'Give it a site, a feed, several of either, or an OPML file to upload. We find the feed, read it and give the blog a permanent page. No account needed; submissions share the web form’s budget of twenty an hour per address.',
    options: ['--json'],
    examples: ['rssamp submit example.com', 'rssamp submit subscriptions.opml'],
  },
];

/** @type {string[]} */
const COMMAND_NAMES = COMMANDS.map((c) => c.name);

/**
 * The global options, documented once because they apply everywhere.
 *
 * @type {{ flag: string, detail: string }[]}
 */
export const GLOBAL_OPTIONS = [
  { flag: '--api <url>', detail: `API base. Default ${DEFAULT_API}, or $RSSAMP_API.` },
  { flag: '--json', detail: 'Raw JSON, for piping into jq or handing to an agent.' },
  { flag: '--limit <n>', detail: 'Cap the number of results.' },
  { flag: '--offset <n>', detail: 'Skip results, for paging.' },
  { flag: '-h, --help', detail: 'This text.' },
  { flag: '-v, --version', detail: 'Print the version.' },
];

/**
 * `--help`, rendered from {@link COMMANDS}.
 *
 * @returns {string}
 */
export function helpText() {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length));

  const commands = COMMANDS.map((c) => `  rssamp ${c.usage.padEnd(width)}  ${c.summary}`).join('\n');
  const options = GLOBAL_OPTIONS.map(
    (o) => `  ${o.flag.padEnd(width + 2)}  ${o.detail}`,
  ).join('\n');

  return `rssamplifier — the open RSS directory, from your terminal

Usage
${commands}

Options
${options}

Examples
  rssamp topics homelab
  rssamp urls --topic homelab > homelab.txt
  rssamp opml --topic homelab > homelab.opml
  rssamp search "agentic coding" --json | jq '.posts[0]'
`;
}

/** Kept as a constant for callers that had it before helpText() existed. */
const HELP = helpText();

/**
 * Parse argv into a command, positional args and flags.
 *
 * @param {string[]} argv
 * @returns {{ command: string, args: string[], flags: Record<string, string|boolean> }}
 */
export function parseArgs(argv) {
  const flags = {};
  const args = [];
  let command = '';

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '-h' || token === '--help') {
      flags.help = true;
    } else if (token === '-v' || token === '--version') {
      flags.version = true;
    } else if (token === '--json') {
      flags.json = true;
    } else if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      // A flag followed by another flag is a boolean, not a value.
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else if (!command) {
      command = token;
    } else {
      args.push(token);
    }
  }

  return { command, args, flags };
}

/**
 * Base URL for the API, honouring --api then $RSSAMP_API.
 *
 * @param {Record<string, string|boolean>} flags
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function apiBase(flags, env = process.env) {
  const raw = typeof flags.api === 'string' ? flags.api : env.RSSAMP_API || DEFAULT_API;
  return String(raw).replace(/\/+$/, '');
}

/**
 * Truncate for terminal display.
 *
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * The feed URLs in an OPML document.
 *
 * A regex rather than a parser because the only OPML this ever reads is the one
 * the directory generates: every outline is on its own line and every attribute
 * is escaped by the same function. Pointing it at arbitrary OPML would be a
 * mistake, which is why nothing here accepts OPML from anywhere else.
 *
 * @param {string} opml
 * @returns {string[]}
 */
export function feedUrlsFromOpml(opml) {
  const urls = [];
  for (const match of String(opml).matchAll(/xmlUrl="([^"]*)"/g)) {
    const url = unescapeXml(match[1]);
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * @param {string} value
 * @returns {string}
 */
function unescapeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last: doing it first would turn "&amp;lt;" into "<".
    .replace(/&amp;/g, '&');
}

/**
 * The query string shared by `opml` and `urls`.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {string}
 */
function exportQuery(flags) {
  const params = new URLSearchParams();
  if (typeof flags.topic === 'string') params.set('topic', flags.topic);
  if (typeof flags.kind === 'string') params.set('kind', flags.kind);
  if (flags.limit && flags.limit !== true) params.set('limit', String(flags.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function request(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      'user-agent': `rssamplifier-cli/${VERSION}`,
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${res.status} ${res.statusText}: ${truncate(text, 200)}`);
  }

  if (!res.ok) {
    throw new Error(body?.error ? String(body.error) : `${res.status} ${res.statusText}`);
  }
  return body;
}

/**
 * Fetch a non-JSON document — OPML, mostly.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function requestText(url) {
  const res = await fetch(url, { headers: { 'user-agent': `rssamplifier-cli/${VERSION}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv
 * @param {{ log?: (s: string) => void, error?: (s: string) => void, readFile?: (p: string) => Promise<string> }} [io]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, io = {}) {
  const log = io.log ?? ((s) => console.log(s));
  const err = io.error ?? ((s) => console.error(s));

  const { command, args, flags } = parseArgs(argv);

  if (flags.version) {
    log(VERSION);
    return 0;
  }
  if (flags.help || !command || command === 'help') {
    log(helpText());
    return command || flags.help ? 0 : 1;
  }

  const base = apiBase(flags);
  const asJson = Boolean(flags.json);

  try {
    switch (command) {
      case 'submit': {
        if (args.length === 0) {
          err('submit: give at least one URL or an .opml file');
          return 1;
        }

        // An .opml argument is a local file to upload; anything else is a URL.
        const opmlPath = args.find((a) => a.toLowerCase().endsWith('.opml'));
        let payload;

        if (opmlPath) {
          const readFile =
            io.readFile ?? (async (p) => (await import('node:fs/promises')).readFile(p, 'utf8'));
          payload = { opml: await readFile(opmlPath) };
        } else {
          payload = { urls: args };
        }

        const body = await request(`${base}/api/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (asJson) {
          log(JSON.stringify(body, null, 2));
          return body.ok ? 0 : 1;
        }

        for (const a of body.accepted ?? []) {
          log(`${a.existing ? 'already listed' : 'added'}  ${base}/${a.slug}`);
        }
        for (const r of body.rejected ?? []) {
          err(`failed        ${r.url || '(input)'} — ${r.error}`);
        }
        // A submission where nothing was accepted is a failure worth a non-zero
        // exit, so scripts and agents can branch on it.
        return (body.accepted?.length ?? 0) > 0 ? 0 : 1;
      }

      case 'search': {
        const query = args.join(' ').trim();
        if (!query) {
          err('search: give a query');
          return 1;
        }

        const url = new URL(`${base}/api/search`);
        url.searchParams.set('q', query);
        if (flags.limit) url.searchParams.set('limit', String(flags.limit));

        const body = await request(url.toString());

        if (asJson) {
          log(JSON.stringify(body, null, 2));
          return 0;
        }

        if (!body.blogs?.length && !body.posts?.length) {
          log(`No results for "${query}".`);
          return 0;
        }

        for (const b of body.blogs ?? []) {
          log(`blog  ${b.title}\n      ${b.page}`);
        }
        for (const p of body.posts ?? []) {
          log(`post  ${truncate(p.title, 72)}\n      ${p.url ?? p.blogPage}`);
        }
        return 0;
      }

      case 'topics': {
        const url = new URL(`${base}/api/topics`);
        const query = args.join(' ').trim();
        if (query) url.searchParams.set('q', query);
        if (flags.limit) url.searchParams.set('limit', String(flags.limit));
        else if (query) url.searchParams.set('limit', '30');
        if (flags.min) url.searchParams.set('min', String(flags.min));

        const body = await request(url.toString());

        if (asJson) {
          log(JSON.stringify(body, null, 2));
          return 0;
        }

        if (!body.topics?.length) {
          log(query ? `No topics matching "${query}".` : 'No topics yet.');
          // Nothing found is not an error — an agent asking about a subject the
          // directory does not cover wants a clean empty answer, not a failure
          // it has to distinguish from a broken request.
          return 0;
        }

        log(
          query
            ? `${body.total} topics matching "${query}"\n`
            : `${body.total} topics in the directory\n`,
        );
        for (const t of body.topics) {
          const count = `${t.feedCount}`.padStart(6);
          log(`${count} feeds  ${t.slug}`);
        }
        log(`\nNext: rssamp topic ${body.topics[0].slug}`);
        return 0;
      }

      case 'topic': {
        const keyword = args.join(' ').trim();
        if (!keyword) {
          err('topic: give a keyword — try `rssamp topics <query>` to find one');
          return 1;
        }

        const url = new URL(`${base}/api/topics/${encodeURIComponent(keyword)}`);
        if (flags.limit) url.searchParams.set('limit', String(flags.limit));
        if (typeof flags.group === 'string') url.searchParams.set('group', flags.group);

        const body = await request(url.toString());

        if (asJson) {
          log(JSON.stringify(body, null, 2));
          return 0;
        }

        log(`${body.keyword} — ${body.total} feeds\n`);
        for (const f of body.feeds ?? []) {
          log(`  ${truncate(f.title, 52).padEnd(52)}  ${f.feedUrl ?? f.page}`);
        }

        const groups = (body.groups ?? []).map((g) => `${g.group} (${g.feedCount})`);
        if (groups.length > 1) log(`\nGroups: ${groups.join(', ')}`);
        log(`\nSubscribe: ${base}/opml?topic=${encodeURIComponent(body.slug)}`);
        return 0;
      }

      case 'urls': {
        const opml = await requestText(`${base}/opml${exportQuery(flags)}`);
        const urls = feedUrlsFromOpml(opml);

        if (asJson) {
          log(JSON.stringify(urls, null, 2));
          return 0;
        }

        for (const url of urls) log(url);
        // An empty list here almost always means a topic that does not exist,
        // and silently printing nothing reads as "this topic has no feeds".
        if (urls.length === 0) {
          err('no feeds matched — check the topic or kind');
          return 1;
        }
        return 0;
      }

      case 'opml': {
        log(await requestText(`${base}/opml${exportQuery(flags)}`));
        return 0;
      }

      case 'list': {
        const url = new URL(`${base}/api/feeds`);
        if (flags.limit) url.searchParams.set('limit', String(flags.limit));
        if (flags.offset) url.searchParams.set('offset', String(flags.offset));
        if (typeof flags.kind === 'string') url.searchParams.set('kind', flags.kind);

        const body = await request(url.toString());

        if (asJson) {
          log(JSON.stringify(body, null, 2));
          return 0;
        }

        log(`${body.total} blogs in the directory\n`);
        for (const f of body.feeds ?? []) {
          log(`${String(f.slug).padEnd(32)} ${truncate(f.title, 44)}`);
        }
        return 0;
      }

      case 'show': {
        const slug = args[0];
        if (!slug) {
          err('show: give a slug');
          return 1;
        }

        const body = await request(`${base}/api/feeds/${encodeURIComponent(slug)}`);

        if (asJson) {
          log(JSON.stringify(body, null, 2));
          return 0;
        }

        log(body.title);
        if (body.description) log(truncate(body.description, 200));
        log(`\n  site  ${body.siteUrl ?? '—'}`);
        log(`  feed  ${body.feedUrl}`);
        log(`  posts ${body.itemCount}\n`);
        for (const i of body.items ?? []) {
          const when = i.publishedAt ? String(i.publishedAt).slice(0, 10) : '----------';
          log(`  ${when}  ${truncate(i.title, 64)}`);
        }
        return 0;
      }

      default:
        err(`Unknown command: ${command}\n`);
        err(helpText());
        return 1;
    }
  } catch (e) {
    err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

export { HELP, DEFAULT_API, COMMAND_NAMES };

// Run when executed directly, stay quiet when imported. This is what lets the
// installer treat this file as the whole program while the tests still import
// pieces of it. process.argv[1] is absent when node is fed a script on stdin,
// hence the guard rather than a bare comparison.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
