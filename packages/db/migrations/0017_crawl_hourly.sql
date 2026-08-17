-- An hour-by-hour record of what the crawler did.
--
-- /crawlstats can already say what the directory looks like right now, because
-- every figure on it is a count over `feeds`. It cannot say anything about
-- *last* Tuesday: feeds carries one last_fetched_at per row, so the moment a
-- feed is crawled again the previous hour's evidence is overwritten. A chart of
-- throughput needs history, and history has to be written down as it happens.
--
-- Items are the exception — feed_items.created_at is a real timeline — but
-- grouping 1.4M rows by hour took 2.4 seconds against production, on a page
-- that refreshes itself every fifteen seconds and is uncached by design. So the
-- items series is rolled up here too, and the page reads a table with one row
-- per hour instead of one row per post.
--
-- One row an hour is 8,760 rows a year; the poller prunes past 90 days, which
-- is longer than any chart on the page asks for.

create table if not exists crawl_hourly (
  hour      text primary key,             -- 'YYYY-MM-DDTHH', UTC, matching substr(iso, 1, 13)
  -- How many poller ticks reported into this bucket. Zero means the row was
  -- backfilled from feed_items rather than recorded live, which is the
  -- difference between "the crawler fetched nothing" and "nobody was writing
  -- this down yet" — a chart that draws those the same way invents an outage.
  ticks     integer not null default 0,
  fetched   integer not null default 0,
  succeeded integer not null default 0,
  failed    integer not null default 0,
  items     integer not null default 0
);

-- Everything the directory has ingested so far, bucketed by the hour we saw it.
--
-- This walks feed_items once, the same one-time cost 0006 paid to index it, and
-- it is what stops the throughput chart from being empty until the first
-- ninety days of live recording have gone by. `ticks` stays 0 on these rows: we
-- know how many posts arrived, and nothing about how many feeds were tried.
insert into crawl_hourly (hour, items)
  select substr(created_at, 1, 13), count(*)
  from feed_items
  where created_at is not null
  group by 1
  on conflict (hour) do update set items = excluded.items;
