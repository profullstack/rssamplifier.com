-- What the crawler paywall earned, and who paid it.
--
-- traffic_hourly already answers "who is asking and how often", including how
-- many of those we turned away. The half it cannot answer is the half with
-- money in it: the gateway has been selling day passes and writing none of it
-- down, so a sale existed only for as long as the response took to send.
--
-- One row per sale. `ref` is the payment reference and is unique, so a
-- settlement delivered twice books once rather than doubling the day's
-- takings. Per-request rows are fine here, unlike the traffic rollup: a sale
-- is rare, and the write path on this database is the scarce thing.
create table if not exists crawl_sales (
  id          integer primary key autoincrement,
  payer       text,
  ref         text unique,
  days        integer not null default 1,
  price_cents integer not null default 0,
  total_cents integer not null default 0,
  currency    text not null default 'USD',
  user_agent  text,
  agent       text,
  expires_at  text,
  created_at  text not null
);

create index if not exists crawl_sales_payer on crawl_sales (payer, created_at);
create index if not exists crawl_sales_created on crawl_sales (created_at);

-- Badges for the public board. Everything else it shows is projected out of
-- traffic_hourly and crawl_sales; a badge is awarded at a moment and then
-- kept, and that fact lives nowhere else.
create table if not exists leaderboard_badges (
  player     text not null,
  badge      text not null,
  awarded_at text not null,
  primary key (player, badge)
);
