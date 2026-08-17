-- What the crawler is doing, line by line, as it happens.
--
-- The poller is its own Railway service, so its stdout is readable in exactly
-- one place: Railway's log viewer, behind a login, for us. /crawlstats can
-- already say how many feeds were fetched in the last hour and nothing at all
-- about what is being fetched right now — the difference between a dashboard
-- and a log. Everything the two services share they share through this
-- database, so a log line the web app can stream has to be written down here.
--
-- Deliberately a tail rather than an archive: one row per feed crawled plus one
-- per tick summary, pruned by age on the hour. At the default batch of 25 feeds
-- a minute that is about 37k rows a day, so the retention window is what keeps
-- this table small — Railway keeps the durable copy of the same lines.
--
-- The columns are the ones a line needs to render itself, not a serialised log
-- record: `event`/`status` decide the wording and the colour, `subject` is what
-- the line is about, and anything left over rides along in `detail` as JSON.
-- Reading a line back must never require re-parsing a blob to find out whether
-- it was good news.

create table if not exists crawl_log (
  id      integer primary key autoincrement,
  at      text not null,
  -- Matches the poller's own log event names ('crawl', 'discovery', 'topics',
  -- 'crawl-error', …) plus 'feed', which is one feed inside a batch.
  event   text not null,
  -- 'ok' | 'error' | null. The log's only styling decision, and the one thing
  -- worth being able to filter on without understanding the event.
  status  text,
  -- A feed URL, a keyword, a discovery source: whatever this line is about.
  subject text,
  -- The feed's page on the site, when the line is about a feed we have indexed.
  slug    text,
  -- Posts stored, sites queued, topics rebuilt: whatever this event counts.
  amount  integer,
  -- An error message, or a JSON object of the fields that have no column.
  detail  text,
  ms      integer
);

-- The stream reads forward from a cursor, and the cursor is the primary key, so
-- tailing is already an index scan. This one is for the prune: deleting by age
-- would otherwise walk every row the table holds, every hour.
create index if not exists crawl_log_at_idx on crawl_log (at);
