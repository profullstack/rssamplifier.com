-- The topic-alert scan asks for a handful of feeds' items newer than a cursor,
-- ordered by created_at. Without this, Postgres walks the global created_at
-- index from the cursor onward and filters by feed, which on 15M rows ran past
-- the 30-second statement timeout on every alerts tick after the cutover.
-- (feed_id, created_at) makes it one index range per picked feed.
create index if not exists feed_items_feed_created_idx on feed_items (feed_id, created_at);
