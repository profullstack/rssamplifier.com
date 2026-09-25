-- "Which feeds of this category published most recently?"
--
-- The question `latestItems` asks first, and the whole reason a category river
-- is affordable: pick the 400 feeds of a category with the newest material,
-- then read items only from those, per feed, through
-- feed_items_feed_pub_idx. Without this index the pick has to walk
-- feeds_last_published_idx backwards discarding every feed of the wrong
-- category, which is cheap for blogs — most of the directory — and expensive
-- for exactly the categories the river was built for. Reels and comics are a
-- few hundred feeds among half a million.
--
-- Partial on the same condition as feeds_last_published_idx, and for the same
-- reason: null is "not crawled since 0030 added the column", which is not
-- evidence of anything, and indexing those rows would make this mostly a list
-- of feeds nobody has read yet.
--
-- `desc` in the declaration rather than relying on a backwards scan: the
-- planner can walk either way, but the river always wants newest first and
-- saying so keeps the intent in the schema.
create index if not exists feeds_category_published_idx
  on feeds (category, last_published_at desc)
  where last_published_at is not null;
