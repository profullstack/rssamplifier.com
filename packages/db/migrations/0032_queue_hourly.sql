-- An hour-by-hour record of how much work was waiting.
--
-- The sibling of 0017, and it exists for the same reason: /crawlstats can say
-- how deep each queue is *now*, because every backlog on it is a count over
-- `feeds`, and it can say nothing at all about an hour ago. A queue is the one
-- number where that hurts most. A backlog of twelve thousand means nothing on
-- its own — it is either a crawler falling behind or a crawler halfway through
-- catching up, and those are opposite emergencies. Only the slope tells them
-- apart, and a slope has to be written down as it happens.
--
-- Deliberately not columns on `crawl_hourly`. That table holds counters that
-- are summed as ticks arrive; these are gauges, sampled. Adding a gauge to a
-- table whose every other column accumulates is how somebody eventually writes
-- `due = due + excluded.due` and draws a chart of nonsense.
--
-- One row an hour, holding the *last* sample taken in it. Last rather than
-- average because a burndown is read as "where had it got to", and rather than
-- min/max because the poller samples often enough that the distinction is
-- noise. `at` is kept so a reader can tell a fresh sample from a stale one:
-- with the poller down, the current hour's row simply stops being rewritten,
-- and a chart that cannot see that would draw a flat line and call it stable.
create table if not exists queue_hourly (
  hour        text primary key,          -- 'YYYY-MM-DDTHH', UTC, matching substr(iso, 1, 13)
  at          text not null,             -- when this sample was taken
  -- Feeds already overdue for a re-read. The deep one by design: it is meant to
  -- carry a backlog, and its chart is read for slope rather than height.
  due         integer not null default 0,
  -- Imported or discovered feeds never yet read. Drains through the same
  -- workers as `due`, which is why the two are worth seeing on one axis.
  first_crawl integer not null default 0,
  -- Feeds with no card picture yet.
  cards       integer not null default 0,
  -- Feeds whose site has never been looked at for its author. The largest
  -- queue in the system by a wide margin and the slowest to move, so it is the
  -- one where a week of slope is worth more than any instantaneous count.
  authors     integer not null default 0
);
