-- The crawl tier, as the dispatcher reads it: due feeds per tier, oldest due
-- first (queries.js dueFeeds / TIER_SQL). The expression must stay exactly what
-- tierSql('fetch_interval_minutes') from @profullstack/scraper-daemon/cadence
-- returns, or the planner will not use this index.
--
-- Concurrently, because feeds is read by every page: migrate() runs each
-- statement on its own with no transaction around the file, which is what
-- create index concurrently needs. Built by hand on production first, so on
-- boot this is a no-op.
create index concurrently if not exists feeds_due_tier_idx
  on feeds ((case when fetch_interval_minutes <= 60 then 0 when fetch_interval_minutes <= 1440 then 1 when fetch_interval_minutes < 10080 then 2 when fetch_interval_minutes <= 10080 then 3 else 4 end), next_fetch_at)
  where status <> 'dead';
