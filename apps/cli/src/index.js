/**
 * rssamplifier CLI.
 *
 * Talks to the public HTTP API rather than the database, so it needs no
 * credentials and works against any deployment — including a local one via
 * `--api http://localhost:3000`.
 *
 * Zero dependencies: argument parsing and output formatting are small enough to
 * own, and a CLI people install globally should not drag a tree behind it.
 */

const DEFAULT_API = 'https://rssamplifier.com';

const HELP = `rssamplifier — the open RSS directory, from your terminal

Usage
  rssamp submit <url|file.opml> [more…]   Add blogs to the directory
  rssamp search <query>                   Search every indexed post
  rssamp list [--limit N] [--offset N]    List blogs in the directory
  rssamp show <slug>                      One blog and its recent posts
  rssamp opml [> feeds.opml]              Export the whole directory as OPML

Options
  --api <url>     API base (default: ${DEFAULT_API}, or $RSSAMP_API)
  --json          Raw JSON output, for piping into jq or an agent
  --limit <n>     Cap results
  --offset <n>    Skip results
  -h, --help      This text
  -v, --version   Print version

Examples
  rssamp submit example.com
  rssamp submit subscriptions.opml
  rssamp search "agentic coding" --json | jq '.posts[0]'
  rssamp opml > feeds.opml
`;

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
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function request(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      'user-agent': 'rssamplifier-cli',
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
    log('0.1.0');
    return 0;
  }
  if (flags.help || !command || command === 'help') {
    log(HELP);
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

      case 'list': {
        const url = new URL(`${base}/api/feeds`);
        if (flags.limit) url.searchParams.set('limit', String(flags.limit));
        if (flags.offset) url.searchParams.set('offset', String(flags.offset));

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

      case 'opml': {
        const res = await fetch(`${base}/opml`, {
          headers: { 'user-agent': 'rssamplifier-cli' },
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        log(await res.text());
        return 0;
      }

      default:
        err(`Unknown command: ${command}\n`);
        err(HELP);
        return 1;
    }
  } catch (e) {
    err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

export { HELP, DEFAULT_API };
