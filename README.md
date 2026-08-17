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
| `/discover` | Keyword search — name a subject, we go and find blogs about it |
| `/discoveries/{id}` | Progress of one keyword run: what was added, and why the rest was not |
| `/crawlstats` | Crawler and discovery queues, live (`/crawlstatus` redirects here) |
| `/random` | Redirect to a random blog — the toolbar's ✦ |

## Agent endpoints

All send `access-control-allow-origin: *` and need no key.

| Path | What |
| --- | --- |
| `/llms.txt` | The directory described for language models |
| `/api/feeds` | Every blog, paginated (`?limit=`, `?offset=`) |
| `/api/feeds/{slug}` | One blog with recent items |
| `/api/search?q=` | Full-text search as JSON (`?limit=`, `?mode=any`) |
| `/opml` | The whole directory as a subscription list |
| `/api/submit` | `POST {"url"}`, `{"urls":[…]}` or `{"opml":"…"}` |
| `/api/discover` | `POST {"keywords":[…]}` — up to 100 keywords per run |
| `/api/discoveries/{id}` | Progress of one keyword run |
| `/api/crawlstats` | Crawler health, including the two discovery queues |
| `/mcp` | MCP endpoint — and the documentation page, in a browser |

```bash
curl -X POST https://rssamplifier.com/api/submit \
  -H 'content-type: application/json' \
  -d '{"urls":["example.com","another.blog"]}'

curl -X POST https://rssamplifier.com/api/discover \
  -H 'content-type: application/json' \
  -d '{"keywords":["siberian huskies"]}'
```

## MCP server

The directory speaks the Model Context Protocol, so an agent can call it rather
than scrape it. It runs inside the web app — no second service, no second
deploy — and the endpoint is the same URL as its documentation page:

```bash
claude mcp add --transport http rssamplifier https://rssamplifier.com/mcp
```

Ten tools: `search`, `list_feeds`, `get_feed`, `list_topics`, `get_topic`,
`topic_posts`, `read_post`, `random_feed`, `directory_stats` and `submit_feed`.
All but the last are reads, and none needs a key. One resource, `llms.txt`.

Keyword discovery is deliberately **not** a tool: every keyword spends a credit
against a metered search plan, and a tool anyone can connect to should not be
able to spend money. It stays a form at `/discover`.

Worth knowing if you touch it:

- **The code lives in `apps/web/src/lib/mcp/`.** `protocol.js` is pure — versions,
  framing, header validation — and is where the tests bite. `tools.js` is the
  tool table, `server.js` dispatches, and `app/api/mcp/route.js` is a thin HTTP
  wrapper. Adding a tool means adding one entry to `TOOLS`; the documentation
  page renders from the same array, so it cannot drift.
- **It is dual-era and stateless.** MCP dropped the `initialize` handshake in
  revision `2026-07-28` in favour of per-request metadata; older clients still
  open with `initialize`. Both are answered on one endpoint, which is only
  cheap because there is no session to keep either way.
- **`/mcp` is a page *and* an endpoint.** Next cannot put a `page.jsx` and a
  `route.js` in one segment, so `next.config.mjs` rewrites the path to
  `/api/mcp` before the filesystem is consulted when the request looks like MCP
  traffic — the protocol's own headers, an SSE `Accept`, a CORS preflight or a
  JSON body. A browser falls through to the page. The endpoint answers at
  `/api/mcp` too.

## Finding blogs by keyword

Submission needs someone to already know a blog exists. Discovery is the other
direction: give it a subject and it searches the web (ValueSERP), collects the
sites that come back, resolves a feed on each and keeps the ones that are
actually blogs about that subject.

Two things make it survive a hundred keywords at once. Both slow phases are
queued — keywords to search, then sites to check — and the request only spends
a fixed time budget on each before handing the rest to the poller. And search
results never touch the `feeds` table directly: they wait in
`discovery_candidates` until a feed has been resolved and judged, because a row
in `feeds` is a public page and a search result is nobody's recommendation.

A site is added only if a feed can be found and it passes both gates:

- **Worthiness** (`packages/feed/src/worthiness.js`) — at least two entries, a
  post inside about eighteen months, entries that link somewhere and do not all
  share one title. Comment feeds and tag feeds are refused outright.
- **Relevance** (`packages/feed/src/relevance.js`) — half the keyword's
  significant words, stemmed, must appear in the feed's text. This is what stops
  a search for "siberian huskies" adding a veterinary clinic's newsletter.

Configuration:

| Variable | Default | What |
| --- | --- | --- |
| `VALUESERP_API_KEY` | — | Required. Without it `/api/discover` answers 503 and the form says so. |
| `DISCOVERY_KEYWORD_BATCH_SIZE` | 5 | Keyword searches the poller runs per tick, and a ceiling rather than a count: a tick stops starting keywords after two minutes, so a slow provider delays the crawl by that much and no more. |
| `DISCOVERY_BATCH_SIZE` | 10 | Candidate sites the poller checks per tick |

Credits are the thing to watch: each keyword costs one credit **per result
page**, and a keyword now pages until it has a hundred results — up to twelve
credits, where it used to spend three.

That is what buys the hundred. `&num=` is not the page size the engine serves,
it is the stride `page` walks in: the offset upstream is `(page - 1) * num`.
Asking for `num=100` put page two at result 101, past the end of a result set
Google truncates well before then, so it came back empty and every keyword
stopped after one page. Measured on the live API, same account, same day:
"prepping" returned 9 unique results at `num=100` and 87 at `num=10`.

Pages come back in eight to ten results each and overlap slightly, so a hundred
unique results takes eleven or twelve pages. They are fetched four at a time —
a page takes anywhere from 3s to 34s, and sequential paging would put a single
keyword over the request's own budget.

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
