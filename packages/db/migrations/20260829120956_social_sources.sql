-- Social sources: X and Reddit get an identity and a namespace of their own.
--
-- Two columns on `feeds` rather than a `sources` table beside it. The PRD
-- sketches the second (§20) and it would be the right shape for a system that
-- did not already have one: `feeds` + `feed_items` is exactly the sources/items
-- pair that section describes, already carrying dedupe, scheduling, backoff,
-- keyword extraction, full-text search, alerts and syndication. A parallel pair
-- would need every one of those written a second time, and §30's "topic code
-- must not contain X-specific provider logic" would become a rule somebody has
-- to remember rather than a fact about the schema.
--
-- `source_kind` was the obvious place to put this and is deliberately not used.
-- It carries `check (source_kind in ('feed', 'scraped'))`, and SQLite cannot
-- alter a CHECK constraint — widening it means rebuilding a table that now has
-- thirty-odd columns, a dozen indexes, foreign keys from six others and FTS
-- triggers, against 300k rows on a database with a single writer. The two new
-- columns say the same thing and cost nothing.

-- Which platform, or null for the ordinary web. Left unconstrained on purpose:
-- the next network to get a namespace should be a migration that adds rows, not
-- one that rebuilds a table for the reason above.
alter table feeds add column social_network text;

-- Our canonical identity for the source: `r:sub:programming`, `x:user:openai`.
-- This is the column that makes §37/§38 true — a thousand readers asking for
-- @OpenAI collapse onto one row here, and therefore onto one polling job.
alter table feeds add column social_ref text;

-- Per-source render toggles (§6.3): includeReplies, includeReposts,
-- includeQuotes. JSON because they are read as a set and never queried on.
alter table feeds add column social_config text;

-- One row per canonical source. Partial, so the 300k feeds that are not social
-- do not each occupy an index entry for a null.
create unique index if not exists feeds_social_ref_idx
  on feeds (social_ref) where social_ref is not null;

-- Listing a network's sources: /r and /x, and the status page's counts.
create index if not exists feeds_social_network_idx
  on feeds (social_network, created_at desc) where social_network is not null;

-- ---------------------------------------------------------------------------
-- Backfill: the Reddit sources that are already here.
--
-- A bulk import put 50,099 subreddits in the directory, each at a slug of its
-- own among the blogs — see the comment on markHostThrottled in queries.js,
-- where the same import is why one host can be 41% of the crawl queue. They are
-- not moved, renamed or deleted: they gain an identity, which is what lets
-- /r/programming answer, and their own /{slug} keeps working for every link
-- already pointing at it.
--
-- The name is extracted rather than matched, because the stored URLs come from
-- an OPML file and take every shape Reddit serves: with and without `www.`, on
-- `old.`, with `.rss`, with a sort segment, with a query string. A view holds
-- that arithmetic once — it is unpleasant enough written out that a second copy
-- would be a second place to get it subtly wrong.
create view if not exists _social_backfill_raw as
with candidates as (
  select
    id,
    feed_url,
    case
      when instr(feed_url, 'reddit.com/r/') > 0 then 'sub'
      when instr(feed_url, 'reddit.com/user/') > 0 then 'user'
    end as mode,
    case
      when instr(feed_url, 'reddit.com/r/') > 0
        then substr(feed_url, instr(feed_url, '/r/') + 3)
      when instr(feed_url, 'reddit.com/user/') > 0
        then substr(feed_url, instr(feed_url, '/user/') + 6)
    end as tail
  from feeds
  where social_ref is null
    and (instr(feed_url, 'reddit.com/r/') > 0 or instr(feed_url, 'reddit.com/user/') > 0)
)
select
  id,
  feed_url,
  mode,
  -- Everything up to whichever of `/`, `.` or `?` comes first. The `|| c`
  -- makes instr() certain to find each one, so there is no zero to special-case.
  substr(tail, 1, min(instr(tail || '/', '/'), instr(tail || '.', '.'), instr(tail || '?', '?')) - 1) as name
from candidates;

-- The same, filtered to names that really are names. A subreddit is 3-21 of
-- [A-Za-z0-9_] and a username 3-20 of that plus `-`; anything else extracted
-- from that position is not one, and guessing would file somebody's blog under
-- a community that does not exist.
create view if not exists _social_backfill as
select
  id,
  mode,
  name,
  -- Is this URL already the document Reddit publishes, rather than a sort tab
  -- or an `old.` mirror of it? Used only to decide who wins a collision.
  case
    when feed_url = 'https://www.reddit.com/r/' || name || '/.rss' then 1
    when feed_url = 'https://www.reddit.com/user/' || name || '/.rss' then 1
    else 0
  end as canonical
from _social_backfill_raw
where name is not null
  and (
    (mode = 'sub' and length(name) between 3 and 21 and name not glob '*[^A-Za-z0-9_]*')
    or
    (mode = 'user' and length(name) between 3 and 20 and name not glob '*[^A-Za-z0-9_-]*')
  );

-- Two passes, and the order is the whole reason there are two.
--
-- The mapping is many-to-one: `/r/x/.rss` and `/r/x/new/.rss` are two rows and
-- one community, and the unique index above is what says so. `update or ignore`
-- means the loser keeps a null ref and stays an ordinary feed rather than
-- failing this migration — a duplicate row is a tidiness problem, and aborting
-- a deploy over one would be the worse trade.
--
-- But *which* row loses would otherwise be decided by rowid, which is to say by
-- the order an OPML file happened to list them in. Claiming the canonical
-- spellings first makes it deterministic and picks the better row: /r/programming
-- ends up backed by the feed Reddit publishes for that community, not by
-- whichever sort tab was imported first.
update or ignore feeds
set social_network = 'reddit',
    social_ref = (select 'r:' || b.mode || ':' || lower(b.name)
                    from _social_backfill b where b.id = feeds.id)
where id in (select id from _social_backfill where canonical = 1);

update or ignore feeds
set social_network = 'reddit',
    social_ref = (select 'r:' || b.mode || ':' || lower(b.name)
                    from _social_backfill b where b.id = feeds.id)
where id in (select id from _social_backfill);

drop view if exists _social_backfill;
drop view if exists _social_backfill_raw;

-- ---------------------------------------------------------------------------
-- Provider and session health (§20, §32).
--
-- Note what is absent from both tables: there is no token column, and there is
-- no room for one. X session credentials are a full login to an account, and
-- they live in the environment (`X_SESSIONS`) precisely so that a leaked
-- database dump — the likeliest way any of this escapes — carries none of them.
-- These tables hold the state that has to survive a redeploy: which provider is
-- in cooldown, which session is expired, and why. See §36 and AC-7.

create table if not exists x_provider_state (
  provider             text primary key,
  status               text not null default 'unknown',
  last_success_at      text,
  last_failure_at      text,
  consecutive_failures integer not null default 0,
  cooldown_until       text,
  -- A message, truncated by the writer. Never a URL with a query string: a
  -- provider URL can carry a session token, which is what redact() in
  -- providers/http.js exists to strip before anything reaches here or a log.
  error_message        text
);

create table if not exists x_sessions (
  -- The id from X_SESSIONS. A name, not a secret.
  id                   text primary key,
  status               text not null default 'healthy',
  cooldown_until       text,
  last_used_at         text,
  consecutive_failures integer not null default 0,
  last_error           text
);
