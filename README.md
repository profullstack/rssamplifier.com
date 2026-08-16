# rssamplifier.com

An open, agent-first directory of independent blogs.

Submit a URL, a list of URLs or an OPML file. We resolve it to a feed, read it, and give the blog a
permanent page at `/<slug>/` with its latest summaries. No account, no paywall, no waiting list.

The point of difference is the machine-readable half: most of the web now blocks AI crawlers, and
this directory deliberately does the opposite. Everything is also published as JSON, OPML and plain
text so an agent can read the whole thing in one request.

## Layout

A pnpm workspace. Every deployable runs in Docker on Railway.

```
apps/web/        Next.js — public pages, JSON API, agent surfaces
apps/poller/     Crawler daemon — re-fetches feeds on a backoff schedule
packages/feed/   Feed discovery, RSS/Atom/JSON Feed parsing, OPML, SSRF guards
packages/ingest/ Submit + crawl orchestration against Supabase
supabase/        Schema migration
```

`packages/*` are plain ESM with JSDoc types — no build step, so Docker stays simple and
`node --test` runs them directly. Only the Next app is compiled.

## Running locally

```bash
pnpm install
cp .env.example .env        # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
pnpm dev                    # web on :3000
pnpm poll                   # crawler, in a second terminal
pnpm test                   # feed library unit tests
```

Apply `supabase/migrations/` to your project before first run.

## Public endpoints

| Path | What |
| --- | --- |
| `/` | Directory index, newest first |
| `/<slug>` | One blog: metadata plus its latest posts |
| `/search?q=` | Full-text search over posts and blogs |
| `/submit` | Human submission form (URLs or OPML upload) |
| `/random` | Redirect to a random blog — the toolbar's ✦ |

## Agent endpoints

All of these send `access-control-allow-origin: *` and need no key.

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

## Design notes worth knowing

- **Submission is unauthenticated, so the fetch layer is the security boundary.**
  `packages/feed/src/fetch.js` resolves every hostname and refuses private, loopback, link-local and
  CGNAT addresses — including after a redirect, and including IPv4-mapped IPv6. Without that, the
  submit endpoint would be a server-side request forgery primitive pointed at Railway's internal
  network and the cloud metadata endpoint. Responses are capped at 5 MB and time out at 15 s.
- **Submitter IPs are HMAC'd with a salt, never stored raw**, and hashing is skipped entirely when
  `IP_HASH_SALT` is unset rather than falling back to a predictable digest — the IPv4 space is small
  enough to reverse a bare SHA-256 in seconds.
- **Crawl failures back off** (1 h → 3 h → 6 h → 12 h → 24 h) instead of retrying hard. Ten
  consecutive failures marks a feed `dead`: we stop crawling but keep serving its archive page.
- **Feed resolution tries the standards-based path first** — `<link rel="alternate">` — and only
  then guesses conventional paths like `/feed.xml`.
- **`Response.redirect` is avoided in route handlers** in favour of an explicit 302, so redirects
  stay relative and no origin is hard-coded.

## Deployment

Two Railway services off this one repo, each with its own Dockerfile:

- `web` → `apps/web/Dockerfile` (Next standalone output)
- `poller` → `apps/poller/Dockerfile`

Both build from the repo root so the workspace packages are in context. Set `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SITE_URL` and `IP_HASH_SALT` on both.

## Licence

© Profullstack, Inc.
