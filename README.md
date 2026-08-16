# rssamplifier.com

An open, agent-first directory of independent blogs.

Submit a URL, a list of URLs or an OPML file. We resolve it to a feed, read it, and give the blog a
permanent page at `/<slug>` with its latest summaries. No account, no paywall, no waiting list.

The point of difference is the machine-readable half: most of the web now blocks AI crawlers, and
this directory deliberately does the opposite. Everything is also published as JSON, OPML and plain
text so an agent can read the whole thing in one request.

**Live:** <https://rssamplifier.up.railway.app>

## Layout

A pnpm workspace. Both deployables run in Docker on Railway.

```
apps/web/        Next.js — public pages, JSON API, agent surfaces, PWA
apps/poller/     Crawler daemon — re-fetches feeds on a backoff schedule
apps/cli/        @profullstack/rssamplifier — the directory from a terminal
packages/feed/   Feed discovery, RSS/Atom/JSON Feed parsing, OPML, SSRF guards
packages/ingest/ Submit + crawl orchestration
packages/db/     Turso/libSQL client, migrations and every query
```

Everything outside the Next app is plain ESM with JSDoc types — no build step, so Docker stays
simple and `node --test` runs the suites directly.

## Running locally

```bash
pnpm install
cp .env.example .env     # TURSO_DATABASE_URL=file:./local.db works with no account
pnpm dev                 # web on :3000
pnpm poll                # crawler, in a second terminal
pnpm test                # 42 tests
```

The poller applies migrations on boot. To run them by hand:

```bash
pnpm --filter @rssamplifier/db migrate
```

## Public endpoints

| Path | What |
| --- | --- |
| `/` | Directory index, newest first |
| `/<slug>` | One blog: metadata plus its latest posts |
| `/search?q=` | Full-text search (SQLite FTS5) |
| `/submit` | Submission form — URLs or an OPML upload |
| `/random` | Redirect to a random blog — the toolbar's ✦ |

## Agent endpoints

All send `access-control-allow-origin: *` and need no key.

| Path | What |
| --- | --- |
| `/llms.txt` | The directory described for language models |
| `/api/feeds` | Every blog, paginated (`?limit=`, `?offset=`) |
| `/api/feeds/{slug}` | One blog with recent items |
| `/api/search?q=` | Full-text search as JSON |
| `/opml` | The whole directory as a subscription list |
| `/api/submit` | `POST {"url"}`, `{"urls":[…]}` or `{"opml":"…"}` |

```bash
curl -X POST https://rssamplifier.com/api/submit \
  -H 'content-type: application/json' \
  -d '{"urls":["example.com","another.blog"]}'
```

Blog pages carry schema.org `Blog` / `BlogPosting` JSON-LD, and `robots.txt` names the AI crawlers
explicitly to allow them rather than merely not blocking them.

## CLI

```bash
npm i -g @profullstack/rssamplifier

rssamp submit example.com
rssamp submit subscriptions.opml
rssamp search "agentic coding" --json | jq '.posts[0]'
rssamp list --limit 20
rssamp show danluu-com
rssamp opml > feeds.opml
```

Talks to the public HTTP API, so it needs no credentials. Point it elsewhere with `--api` or
`$RSSAMP_API`. Zero dependencies.

## Design notes worth knowing

- **Submission is unauthenticated, so the fetch layer is the security boundary.**
  `packages/feed/src/fetch.js` resolves every hostname and refuses private, loopback, link-local and
  CGNAT addresses — after redirects too, and including IPv4-mapped IPv6. Without it the submit
  endpoint would be an SSRF primitive aimed at Railway's internal network and the cloud metadata
  endpoint. Responses cap at 5 MB and time out at 15 s.
- **Submitter IPs are HMAC'd with a salt, never stored raw**, and hashing is skipped entirely when
  `IP_HASH_SALT` is unset rather than falling back to a predictable digest.
- **Crawl failures back off** (1 h → 3 h → 6 h → 12 h → 24 h). Ten consecutive failures marks a feed
  `dead`: crawling stops, the archive page stays up.
- **FTS5 runs in external-content mode**, so the triggers in `0001_init.sql` are load-bearing —
  without them the search index silently drifts from the table.
- **User queries are quoted before hitting FTS5.** Bare punctuation is FTS5 syntax, so `C++` or
  `foo AND` would otherwise be a syntax error rather than a search.
- **The Docker image does not use Next's `output: standalone`.** Its tracing walks real filesystem
  paths and misses next's own `@swc/helpers` under pnpm's symlinked store, producing a bundle that
  builds and then dies on boot. The image carries real `node_modules` instead.
- **Nothing pins the web port.** Railway injects `PORT`; passing `-p` to `next start` would override
  it and leave the edge proxy talking to a closed port.

## Deployment

Two Railway services in the shared Profullstack project, both building from this repo with
`RAILWAY_DOCKERFILE_PATH` pointing at their own Dockerfile:

- `rssamplifier.com` → `apps/web/Dockerfile`
- `rssamplifier-poller` → `apps/poller/Dockerfile`

Secrets live in logicsrc: `logicsrc teams pull profullstack rssamplifier-com prod`.

## Licence

© Profullstack, Inc.
