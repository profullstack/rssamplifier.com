-- One story, told by many feeds.
--
-- A directory of this size carries the same announcement dozens of times, and a
-- topic river built out of that shows a reader one story twelve times over. The
-- key is a hash of the headline's significant words, computed when the item is
-- stored, so grouping later is a string comparison rather than a similarity
-- search over millions of rows.
--
-- Three states, and the difference between two of them is what lets the
-- backfill terminate:
--
--   a hash  -- group this item with anything carrying the same hash
--   ''      -- looked at, and deliberately never grouped: the title is too
--              short or too generic to be safe ("Weeknotes", "Links")
--   NULL    -- not yet examined; written before this column existed
--
-- Collapsing the middle case into NULL would leave every ungroupable row in the
-- worker's queue for good, and it would re-examine them on every pass forever.
alter table feed_items add column cluster_key text;

-- The river reads recent items and groups them. Leading with published_at keeps
-- that scan on the same axis the river already orders by, so grouping costs no
-- extra pass over the table.
create index if not exists feed_items_cluster_idx
  on feed_items (published_at desc, cluster_key);

-- How the backfill worker finds what it has not reached yet. Partial, so it
-- indexes only the shrinking set of un-keyed rows and disappears to nothing
-- once the backfill has drained.
create index if not exists feed_items_cluster_backfill_idx
  on feed_items (id) where cluster_key is null;
