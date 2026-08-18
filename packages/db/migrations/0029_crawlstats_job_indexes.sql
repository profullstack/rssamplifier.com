-- The rest of /crawlstats, and a correction to what 0028 said about the cost of
-- an index on this table.
--
-- 0028 added exactly one index and argued against adding a second on
-- `last_fetched_at`, on the grounds that the column is rewritten on every crawl
-- and every index over it is another b-tree write on the hottest write path.
-- That reasoning was wrong, and the measurement that disproves it was in the
-- same commit message: a 1-row upsert, a 100-row upsert and a no-op write
-- transaction all took the same 30-50 seconds, because the cost is *acquiring*
-- the write path, not the work done once it is held. What limits the crawler is
-- the number of write transactions per feed. An extra index entry maintained
-- inside a transaction that is already committing costs nothing measurable
-- against a wait of that size.
--
-- So the trade the earlier note refused is a trade worth taking, and these two
-- indexes are what the remaining slow reads on that page need.

-- `recentlyCrawled` — "what has the crawler just touched", 15 rows, ordered by
-- when. Without this it is a scan of all 368k feed rows plus a sort, measured at
-- 2,413ms; with it, a seek to the end of the index and fifteen steps back.
create index if not exists feeds_fetched_at_idx
  on feeds (last_fetched_at);

-- The feed-picture breakdown in `jobBacklogs`, which counts every feed by
-- `card_state` and asks how many were checked in the last hour. Both come off
-- one covering scan of this index instead of a scan of the table itself, which
-- is the distinction that matters here: a conditional aggregate is not slow
-- because it is conditional, it is slow when it drags 14 GB of rows through
-- memory to evaluate the condition. Over a two-column covering index the same
-- CASE is cheap.
--
-- `feeds_card_due_idx` (0023) cannot serve either: it is partial on
-- `card_state is not 'ok'`, so it deliberately does not contain the finished
-- rows that this breakdown is mostly counting.
create index if not exists feeds_card_state_idx
  on feeds (card_state, card_checked_at);
