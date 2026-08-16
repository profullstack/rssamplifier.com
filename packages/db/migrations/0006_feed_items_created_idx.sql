-- An index on when an item was ingested.
--
-- /crawlstats asks how many posts arrived in the last 24 hours, and without
-- this that question reads every row in the largest table in the database. On
-- production data the status page took 46 seconds to answer; the count was all
-- of it.
--
-- feed_items already has an index on published_at, which is a different
-- question: published_at is what the blog claims, created_at is when we saw it.
-- A crawler's throughput is measured in the second.
--
-- Building this walks the whole table once, so the poller's boot-time migration
-- will pause for it on the first deploy. One pause, and every status request
-- after it is a range scan.

create index if not exists feed_items_created_idx on feed_items (created_at);
