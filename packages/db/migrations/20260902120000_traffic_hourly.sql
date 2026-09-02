-- Who is actually asking, and for what.
--
-- The directory invites every crawler by name in robots.txt and answers its API
-- without a key, which is deliberate. The cost of that choice was never
-- measured, though: request volume is known only as an unattributed total from
-- the platform, so "a million pageviews" cannot be split into readers, agents
-- calling the API on purpose, and scrapers taking the long way round every HTML
-- page. Those three want opposite things done about them, and the free tier's
-- ceiling cannot be chosen without knowing which of them it would bind.
--
-- Shaped like crawl_hourly and queue_hourly: one row per hour per (agent, path
-- bucket), accumulated with an upsert. Per-request rows are not an option here
-- -- a write transaction on this database can take half a minute under crawl
-- load, and there is no version of that which belongs in a page render.
-- `tier` is here because it is the column the pricing question is actually
-- about. The throttle already exempts anyone holding a session cookie, so
-- "anonymous" and "signed in" are today the difference between metered and
-- unmetered, and nobody knows what share of traffic each is. Splitting a free
-- ceiling from a ten-times-larger authenticated one is guesswork until that
-- split is on the table.
create table if not exists traffic_hourly (
  hour   text not null,          -- 'YYYY-MM-DDTHH', UTC, matching substr(iso, 1, 13)
  agent  text not null,          -- classified user-agent family, never the raw string
  bucket text not null,          -- which kind of route was asked for
  tier   text not null,          -- anon | session | key
  hits   integer not null default 0,
  primary key (hour, agent, bucket, tier)
);

create index if not exists traffic_hourly_hour on traffic_hourly (hour);
