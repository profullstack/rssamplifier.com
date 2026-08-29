# rssamplifier.com

An open, agent-first directory of independent blogs.

Submit a URL, a list of URLs or an OPML file. We resolve it to a feed, read it, and give the blog a
permanent page at `/<slug>` with its latest summaries. No account, no paywall, no waiting list.

The point of difference is the machine-readable half: most of the web now blocks AI crawlers, and
this directory deliberately does the opposite. Everything is also published as JSON, OPML and plain
text so an agent can read the whole thing in one request.

**Live:** <https://rssamplifier.com>

## Layout

A pnpm workspace. Both deployables run in Docker on Railway.

```
apps/web/        Next.js — public pages, JSON API, agent surfaces, PWA
apps/poller/     Crawler daemon — re-fetches feeds on a backoff schedule
apps/cli/        @profullstack/rssamplifier — the directory from a terminal
packages/feed/   Feed discovery, RSS/Atom/JSON Feed parsing, OPML, SSRF guards
packages/ingest/ Submit + crawl orchestration
packages/db/     Turso/libSQL client, migrations and every query
packages/notify/ Alerts — web push, email digests and webhooks
packages/social/ X and Reddit: canonical identity, and X's provider adapters
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
| `/r` | Every subreddit and Reddit user in the directory |
| `/r/<subreddit>` | One community: `/r/programming`, `.rss` `.atom` `.json` `.md` |
| `/r/u/<user>` | One Reddit user, under the same prefix |
| `/x` | Every X account, search and list in the directory |
| `/x/<handle>` | One timeline: `/x/OpenAI`, plus `/replies` and `/media` |
| `/x/list/<id>` | One X list |
| `/x/search?q=` | An X search as a feed — X's own operators pass through |
| `/x/status` | Which provider is collecting X, and how it is doing |
| `/ig` | Every Instagram account and hashtag in the directory |
| `/ig/<handle>` | One account: `/ig/nasa`, and `/ig/tag/<tag>` for a hashtag |
| `/fb` | Facebook Pages whose operators have connected them |
| `/fb/<page>` | One connected Page |

### The four social namespaces

Reddit and X both live under a prefix of their own, and for the same reason from
opposite directions. Reddit publishes real RSS, so a subreddit resolves down the
ordinary path and lands as an untyped row at a slug of its own — which is how
50,099 of them ended up filed among the blogs. X publishes nothing at all, so
without a provider it is not submittable in the first place.

Instagram is X's shape again — no feeds, collected through RSSHub — and cost
almost nothing to add, which is the point of having built the namespace once.
Facebook is its own thing entirely; see below.

`packages/social` answers one question for all four: **what is the canonical
identity of this thing?** `@OpenAI`, `x.com/OpenAI` and `https://twitter.com/openai/` are
one source (`x:user:openai`, at `/x/OpenAI`); `/r/programming`, `/r/Programming/`
and `/r/programming/new/.rss` are one community (`r:sub:programming`, at
`/r/programming`). One identity means one row, which means **one polling job no
matter how many people subscribe** — the thing that matters most when the
upstream rate-limits per account.

A social source is an ordinary row in `feeds`, not a parallel `sources` table.
That is what lets it inherit dedupe, backoff, interval learning, keyword
extraction, full-text search, alerts, sitemaps and all five syndication formats
without a line of X-specific code in any of them — and it is why an X post can
appear in `/topics/artificial-intelligence.rss` beside a blog post with nothing
to tell them apart.

`/{slug}` still answers for both, and always will: it is the permanent identity
of a row and links already point at it. The `/r/` and `/x/` address is the
canonical one, which is what search engines are told.

## Facebook, and what `/fb/` can honestly be

**There is no way to read an arbitrary public Facebook Page.** Three doors, all
measured on 2026-08-29 rather than assumed:

- the old `facebook.com/feeds/page.php?format=rss20` endpoint answers **404** —
  removed, not deprecated
- `mbasic.facebook.com/<page>` answers 200 with a **login wall**
- RSSHub, which carries a thousand namespaces and maintains Twitter and
  Instagram, has **no Facebook namespace at all**

The one remaining door is Meta's Graph API, and it only opens for Pages the
caller **administers**. Reading somebody else's public Page needs the
`Page Public Content Access` feature, which requires App Review plus business
verification and is granted rarely.

So `/fb/` is the one namespace here that does not take open submissions: a Page
appears when its operator connects it, by putting a Page Access Token in
`FB_PAGE_TOKENS`. A Page nobody has connected is not "not crawled yet", it is
not collectable, and the page says exactly that rather than offering a button
that would quietly do nothing.

```bash
FB_PAGE_TOKENS='[{"page":"MyPage","token":"EAA..."}]'
```

What is deliberately absent: anything that drives a logged-in Facebook session
against that login wall. It breaks constantly, it is against Meta's terms, and
it would risk an account of ours to serve a directory nobody pays for.

## Collecting Instagram

Same shape as X, through the same RSSHub daemon — the `/instagram/2/…` web-api
routes, which authenticate with a cookie rather than the private-api routes,
which want a username and password.

```bash
IG_COOKIE=            # on the RSSHub side; see apps/poller/src/rsshub.js
```

Accounts and hashtags only. Stories expire, and a feed of things that have
already gone is worse than no feed.

## Collecting X

X has no feeds, so posts are collected through a provider and mirrored here.
**Which provider never appears in a public URL** — that is the whole design.
A reader subscribed to `/x/OpenAI.rss` through RSSHub is still subscribed when
the collection method is replaced under them.

```
RSSHub (primary) → Teapot (fallback) → official X API (paid) → cached items
```

Failover is per attempt and the order is fixed; three failures in a row set a
provider aside for a few minutes and one success clears it. Nothing here can
empty a feed: items are only ever written on success, so an outage leaves
yesterday's posts exactly where they were and the public route goes on serving
them.

| Variable | Default | What |
| --- | --- | --- |
| `X_ENABLED` | `false` | The kill switch. Off means no collection; existing feeds keep serving. |
| `X_PRIMARY_PROVIDER` | `rsshub` | First provider tried. |
| `X_FALLBACK_PROVIDERS` | `teapot,official` | Tried in order after it. |
| `RSSHUB_BASE_URL` | — | A self-hosted RSSHub. Unset means the provider is skipped. |
| `RSSHUB_ACCESS_KEY` | — | If that instance requires one. |
| `TEAPOT_BASE_URL` | — | A Teapot or Nitter-shaped instance. |
| `X_API_BEARER_TOKEN` | — | Official API. Unset means that provider is skipped. |
| `X_API_DAILY_READS` | `0` | Spend cap, `0` for unlimited. Also `X_API_MONTHLY_READS`, `X_API_MAX_RPM`. |
| `X_SESSIONS` | — | JSON: `[{"id":"x-1","authToken":"…","ct0":"…"}]` |
| `X_FETCH_TIMEOUT_MS` | `15000` | Upstream deadline. |
| `X_SESSION_COOLDOWN_SECONDS` | `900` | How long a rate-limited session rests. |

**Session credentials live in the environment and never in a table.**
`auth_token` and `ct0` are a full login to an X account — whoever holds them can
post as it and change its password. `x_sessions` and `x_provider_state` hold
health state only, so a leaked database dump carries no credentials, and nothing
renderable about a session is one. Use dedicated accounts, and separate ones for
production and development.

§47 of the PRD also allows the positional pair `X_AUTH_TOKENS` / `X_CT0_TOKENS`.
It works, and it is a trap worth naming: the lists are matched by position, so
deleting one dead account from the middle of the first and forgetting the second
silently pairs every later token with the wrong cookie — a pool of sessions that
all authenticate as nobody. `X_SESSIONS` cannot express that state.

Both unofficial providers keep their own logged-in sessions by default, so the
pool has nothing to hand them unless the deployment exposes a per-request
parameter (`RSSHUB_SESSION_PARAM`, `TEAPOT_SESSION_HEADER`). Nothing here guesses
at those names: guessing would mean putting a live cookie on a query string
somebody else's instance might log.

**Not built:** the `/admin/x` buttons of §34 — disable a provider, clear a
cooldown, force a refresh. This codebase has no notion of an administrator to
guard them with, and shipping the levers before the lock is how a kill switch
becomes a way for anyone to turn collection off. `X_ENABLED` and
`X_PRIMARY_PROVIDER` cover the two that matter without a code deploy.
`/x/status` is the read-only half, and is where those buttons go.

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
| `/api/topics/{keyword}` | The feeds on a topic, its category breakdown, `?group=` to narrow |
| `/topics/{keyword}/{group}.rss` | One category of a topic, as a feed — also `.atom`, `.json`, `.m3u`, `.pls` |
| `/mcp` | MCP endpoint — and the documentation page, in a browser |

```bash
curl -X POST https://rssamplifier.com/api/submit \
  -H 'content-type: application/json' \
  -d '{"urls":["example.com","another.blog"]}'

curl -X POST https://rssamplifier.com/api/discover \
  -H 'content-type: application/json' \
  -d '{"keywords":["siberian huskies"]}'
```

## Topics, and topics by category

A topic page is every feed filed under a subject. On a well-covered one that is
several hundred feeds of different kinds in a single list, so each category the
topic has also gets an address of its own:

| Path | What |
| --- | --- |
| `/topics/physics` | Everything filed under physics |
| `/topics/physics/blogs` | Just the writing |
| `/topics/physics/podcasts` | Just the shows |
| `/topics/physics/audio` | Podcasts and music together |
| `/topics/physics/music`, `/videos`, `/comics`, `/lives`, `/reels` | The rest |

Every one of them is also a feed — `.rss`, `.atom`, `.json`, and `.m3u` / `.pls`
where the entries are files a player can queue. `/topics/physics/audio.m3u` is a
playlist of everything on a subject you can listen to.

Worth knowing if you touch it:

- **The segments are the category pages' own names**, derived from the table in
  `apps/web/src/lib/categories.js` rather than written down twice — so
  `/topics/physics/videos` sits under `/videos`, and a category that is renamed
  renames its sub-group with it. A test asserts the two agree.
- **`audio` is the one group that is not a single category** (podcast + music),
  which is why the queries take a *set* of kinds rather than a kind.
- **A sub-group with no feeds is a 404**, not an empty page. There are eight
  addresses per topic and forty-odd thousand topics; rendering the empty ones
  would be a great deal of thin content nobody asked for.
- **The group is a path segment in the rewrite destination, not `?group=`.** A
  rewrite's destination query string does not reach an App Router route handler
  — `req.url` there is the URL the client asked for — so a query parameter
  arrives as nothing and the feed quietly serves the whole topic. That is why
  there are two routes over one implementation in `apps/web/src/lib/topicFeed.js`.
  `?group=` *does* work when a caller sends it to `/api/topics/...` directly.
- **The pages and the feeds disagree on purpose about unknown groups.** A page
  404s; a feed ignores the group and serves the topic. A page is an address
  somebody can link to, a feed is a subscription somebody has already made.
- The sub-groups are deliberately **not** in the sitemap: at 40k+ topics they
  would multiply it several times over for pages that are a filter on something
  already listed.
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
- **Alerts never replay a backlog.** An account that has just switched alerts on has no watermark,
  and the sender answers that by starting the clock at the present rather than by mailing somebody
  two years of a topic they discovered this afternoon.
- **The alert watermark runs on `feed_items.created_at`, not `published_at`.** One is when the
  crawler saw a post, the other is what the publisher claims — and a backdated import would
  otherwise either replay a year or skip a week.
- **Web push is implemented from the RFCs, not from a library** (`packages/notify/src/webpush.js`).
  A wrongly derived key produces a body that every push service accepts, forwards, and the browser
  silently fails to decrypt, with no error anywhere — so the test pins it to the published worked
  example in RFC 8291 §5 rather than to a round trip through our own code.

## Deployment

Two Railway services in the shared Profullstack project, both building from this repo with
`RAILWAY_DOCKERFILE_PATH` pointing at their own Dockerfile:

- `rssamplifier.com` → `apps/web/Dockerfile`
- `rssamplifier-poller` → `apps/poller/Dockerfile`

Secrets live in logicsrc: `logicsrc teams pull profullstack rssamplifier-com prod`.

### Alerts

Following collects; an alert interrupts. The bell beside Follow on any blog or topic says whether
that follow alerts, and `/account/alerts` says where the alerts go — the browser, email, or a
webhook. The poller sends them on its own timer; nothing else has to be run.

Email needs `RESEND_API_KEY`, which the deployment already has. Browser push needs a VAPID pair,
minted once:

```
pnpm --filter @rssamplifier/notify vapid
```

Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` on **both** services — the web app
hands the public key to browsers, the poller signs with the private one. The pair is an identity:
every subscription in the database was created against that public key, so replacing it later
invalidates all of them at once. Without it the site simply does not offer browser alerts, and the
other two channels work as normal.

Webhooks receive one `POST` of JSON per batch (`{version, type, at, count, items}`). With a signing
secret the body is HMAC'd into `x-rssamplifier-signature: sha256=…` over the exact bytes sent;
`verifySignature` in `packages/notify/src/webhook.js` is the reference for checking it.

## Licence

© Profullstack, Inc.
