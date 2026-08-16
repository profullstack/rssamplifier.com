-- A wider set of categories than `kind` can hold.
--
-- 0009 added `kind` with `check (kind in ('blog', 'podcast'))`, and that
-- migration is already applied in production. SQLite cannot alter or drop a
-- check constraint: widening it means creating a new table, copying 47k rows,
-- dropping the old one and renaming — on a table that other tables reference
-- with `on delete cascade` and that an external-content FTS index tracks by
-- rowid. With foreign keys enforced, the `drop table` step is a cascade delete
-- of every item, keyword, follow and reaction in the directory if anything
-- about the sequence is wrong. That is not a trade worth making to widen an
-- enum.
--
-- So the categories move to a new column with no check constraint. The
-- application is the only writer and it validates against KINDS already, which
-- is where a value this small was always going to be enforced in practice.
--
-- `kind` is left alone: still populated on old rows, no longer read, no longer
-- written. A later migration can drop it during a maintenance window, when a
-- table rebuild is somebody's deliberate decision rather than a side effect of
-- adding a category.

alter table feeds add column category text not null default 'blog';

-- Everything already classified keeps its classification.
update feeds set category = kind;

-- Who decided the category, which decides who may change it.
--
-- Most categories are read off the feed itself on every crawl: a feed that
-- starts publishing audio becomes music, and re-deriving keeps that true. But
-- some categories are not in the document at all — a webcomic's feed looks
-- exactly like a blog with images in it, and no amount of parsing will say
-- otherwise. Those come from a curated list, and a crawler that re-derives
-- every category on every crawl would file them all back under blogs within
-- the hour.
--
-- So a curated category is sticky: the crawler only writes a category it
-- derived over one it derived before.
alter table feeds add column category_source text not null default 'derived'
  check (category_source in ('derived', 'curated'));

create index if not exists feeds_category_created_idx
  on feeds (category, created_at desc, id desc) where status <> 'dead';
