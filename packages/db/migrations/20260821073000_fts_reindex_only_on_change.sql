-- Re-index a row only when the indexed text actually changed.
--
-- `feeds_au` and `feed_items_au` fire on *any* update to their table, and each
-- one does two writes into the FTS index: a delete of the old document and an
-- insert of the new. That is correct, and for a table whose updates are edits
-- it is also cheap. Neither of these tables is that.
--
-- `storeCrawl` updates the feed row on every crawl -- `last_fetched_at`,
-- `next_fetch_at`, `error_count`, `item_count`, the HTTP validators -- and none
-- of those are indexed. The crawler runs ~82,800 crawls a day, so the directory
-- was tearing down and rebuilding ~82,800 FTS documents a day to store the same
-- title and description it stored last time. `feed_items` has the same shape:
-- its upsert only ever fills in a missing picture or enclosure (0001's
-- conflict clause is guarded to skip no-op rows), so `title` and `summary` --
-- the only columns in that index -- are not what changed.
--
-- Turso meters rows written, and FTS5 writes several rows per document into its
-- shadow tables, so this was a standing multiplier on every crawl for no gain.
--
-- `is not` rather than `<>` because both columns are nullable and `null <> null`
-- is null, which a WHEN clause reads as false: a feed that gains or loses a
-- description would silently stop being re-indexed.
--
-- Dropping and recreating is the only way to add a WHEN clause to an existing
-- trigger; SQLite has no ALTER TRIGGER. It touches no data, and the index is
-- unchanged for every row whose text has not moved.

drop trigger if exists feeds_au;

create trigger feeds_au after update on feeds
when old.title is not new.title or old.description is not new.description
begin
  insert into feeds_fts (feeds_fts, rowid, title, description)
  values ('delete', old.rowid, old.title, old.description);
  insert into feeds_fts (rowid, title, description)
  values (new.rowid, new.title, new.description);
end;

drop trigger if exists feed_items_au;

create trigger feed_items_au after update on feed_items
when old.title is not new.title or old.summary is not new.summary
begin
  insert into feed_items_fts (feed_items_fts, rowid, title, summary)
  values ('delete', old.rowid, old.title, old.summary);
  insert into feed_items_fts (rowid, title, summary)
  values (new.rowid, new.title, new.summary);
end;
