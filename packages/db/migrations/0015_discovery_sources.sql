-- Discovery from sources, not just from keywords.
--
-- 0014 built the pipeline: a run holds candidates, the poller resolves each one
-- and promotes what turns out to be a real feed. That pipeline is not specific
-- to search — what varies is only where the candidates came from, and whether
-- anybody vouched for them.
--
-- A keyword run's candidates are a search engine's opinion, so every one is
-- checked for worthiness before it earns a page. A curated list is the
-- opposite: somebody maintained it by hand, and the whole reason to read it is
-- that a parser cannot tell a webcomic from a blog. Those two need different
-- treatment at the same point in the same pipeline, so the run says which it
-- is.

-- What the run's finds are, when the source knows and the parser cannot.
-- Null for keyword runs, where the category is derived from the feed.
alter table discovery_runs add column category text;

-- Whether the source vouched for its candidates.
--
-- A curated run skips the worthiness check — it exists precisely to add feeds
-- a heuristic would not have chosen — and stamps its category as `curated` so
-- the crawler does not re-derive it away on the next pass.
alter table discovery_runs add column curated integer not null default 0;

-- Finding the last run of a source, so a daemon can space its passes out
-- rather than re-reading somebody's list every minute.
create index if not exists discovery_runs_provider_idx
  on discovery_runs (provider, created_at desc);
