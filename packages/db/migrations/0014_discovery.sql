-- Keyword discovery: find blogs by searching the web, not by being handed a URL.
--
-- A submission is someone vouching for a blog, so `submissions` writes straight
-- into `feeds`. Discovery has no such vouching: it is a search engine's opinion
-- of "siberian huskies", and most of what comes back is a shop. Those results
-- therefore land here first and are only promoted into `feeds` once a feed has
-- actually been resolved and passed the worthiness check — `feeds` rows are
-- public pages at rssamplifier.com/<slug>, and unvetted search results must
-- never create one.

create table if not exists discovery_runs (
  id              text primary key,
  -- JSON array of the keywords as submitted, for the status page and for
  -- re-running a set that worked.
  keywords        text not null default '[]',
  keyword_count   integer not null default 0,

  -- running: the request is still working through its inline budget.
  -- queued: inline budget spent, the poller owns the remainder.
  -- complete: no keywords and no candidates left.
  -- failed: the provider refused the run outright.
  status          text not null default 'running'
                  check (status in ('running', 'queued', 'complete', 'failed')),

  provider        text not null default 'valueserp',
  -- Set when the provider itself stopped the run: no-api-key, quota-exhausted,
  -- bad-api-key. Distinct from a run that simply found nothing.
  error           text,

  searched_count  integer not null default 0,
  candidate_count integer not null default 0,
  accepted_count  integer not null default 0,
  rejected_count  integer not null default 0,
  queued_count    integer not null default 0,

  notify_email    text,
  notified_at     text,
  ip_hash         text,
  user_agent      text,

  created_at      text not null,
  updated_at      text not null,
  completed_at    text
);

create index if not exists discovery_runs_created_idx on discovery_runs (created_at desc);

create index if not exists discovery_runs_pending_notice_idx
  on discovery_runs (created_at) where notify_email is not null and notified_at is null;

-- The keywords of a run, individually queued.
--
-- Searching is itself too slow to finish inline: a hundred keywords at a second
-- or two each is minutes, and the request answering the form has a budget of
-- well under that. So keywords queue exactly like the sites they turn up — the
-- request searches what it can and the poller searches the rest.
--
-- This is also what makes a run survive an exhausted search quota. The keywords
-- that never ran stay queued, and the poller picks them up once credits reset,
-- instead of the run being silently half-done for ever.
create table if not exists discovery_keywords (
  id           text primary key,
  run_id       text not null references discovery_runs (id) on delete cascade,
  keyword      text not null,

  status       text not null default 'queued'
               check (status in ('queued', 'searched', 'failed')),

  result_count integer,
  error        text,

  created_at   text not null,
  searched_at  text,

  unique (run_id, keyword)
);

create index if not exists discovery_keywords_queued_idx
  on discovery_keywords (created_at) where status = 'queued';

create index if not exists discovery_keywords_run_idx
  on discovery_keywords (run_id, status);

create table if not exists discovery_candidates (
  id         text primary key,
  run_id     text not null references discovery_runs (id) on delete cascade,
  -- Which keyword surfaced this site. The only explanation a human wants for
  -- why some unfamiliar domain is in their run.
  keyword    text,
  site_url   text not null,
  host       text not null,

  -- queued: waiting for the poller. accepted: promoted into feeds.
  -- rejected: resolved but not worthy. error: no feed found, or unreachable.
  status     text not null default 'queued'
             check (status in ('queued', 'accepted', 'rejected', 'error')),

  feed_url   text,
  -- Slug of the created feed, so the status page can link to what it made.
  slug       text,
  score      integer,
  -- JSON array of worthiness reasons, or a single resolve error.
  reason     text,

  created_at text not null,
  checked_at text,

  -- One row per site per run. The same site surfacing under three keywords is
  -- one candidate, and re-running a keyword must not duplicate its queue.
  unique (run_id, host)
);

-- The poller's claim query: oldest queued candidate first.
create index if not exists discovery_candidates_queued_idx
  on discovery_candidates (created_at) where status = 'queued';

create index if not exists discovery_candidates_run_idx
  on discovery_candidates (run_id, status);

-- Which run created a feed, so a blog's page can say where it came from and so
-- a bad run can be audited after the fact.
alter table feeds add column discovery_run_id text;

create index if not exists feeds_discovery_run_idx
  on feeds (discovery_run_id) where discovery_run_id is not null;
