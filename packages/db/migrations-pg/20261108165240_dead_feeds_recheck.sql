-- 'dead' is no longer for ever (fleet crawler rule, 2026-11-08: flag a slow or
-- broken target and recheck it in a month). A retired feed comes back to the
-- crawler once its next_fetch_at passes, read by recheckFeeds() in queries.js
-- off this partial index: every other due index is `where status <> 'dead'`.
--
-- Concurrently, as feeds_due_tier_idx was: migrate() runs each statement on
-- its own with no transaction around the file.
create index concurrently if not exists feeds_recheck_idx
  on feeds (next_fetch_at)
  where status = 'dead';

-- Feeds retired before this change carry a next_fetch_at from the old ladder
-- (a day at most after their last attempt), which would make all of them due
-- at once. Re-stamp each to thirty days after its last attempt, which is when
-- the new rule would have scheduled its recheck. Idempotent: rerunning it
-- computes the same value from the same column. recheckFeeds only offers a
-- small share of each tick, so the ones already past thirty days drain over a
-- day or two rather than in one burst.
update feeds
   set next_fetch_at = to_char(
         (last_fetched_at::timestamptz + interval '30 days') at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 where status = 'dead'
   and last_fetched_at is not null
   and next_fetch_at < to_char(
         (last_fetched_at::timestamptz + interval '30 days') at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
