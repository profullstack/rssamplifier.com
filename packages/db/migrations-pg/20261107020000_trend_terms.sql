-- What the directory is writing about, one day at a time. A trend is a
-- comparison of two weeks of titles, and feed_items is too large to scan for
-- that on a request, so the poller rolls each finished UTC day into these.

-- One row per day rolled up. `feeds` is the denominator: a day with more feeds
-- in the sample is not a day when everything trended.
create table if not exists trend_days (
  day       text primary key,
  feeds     bigint not null,
  items     bigint not null,
  rolled_at text not null
);

-- How many sampled feeds used a term in a title that day. Feeds, not items, so
-- a firehose posting a thousand times is one voice.
create table if not exists trend_terms (
  day   text not null references trend_days (day) on delete cascade,
  term  text not null,
  feeds bigint not null,
  primary key (day, term)
);
create index if not exists trend_terms_term_idx on trend_terms (term);
