-- An index in export order, so exporting the directory stops sorting it.
--
-- The OPML export walks every non-dead feed ordered by title, a page at a time.
-- Without an index on that ordering, SQLite has to sort the whole table to
-- answer each page — the sort is thrown away between pages, so a single export
-- re-sorts tens of thousands of rows once per page.
--
-- The pair (title, id) matches the export's ORDER BY exactly, which is what
-- lets the keyset cursor resume by seeking into the index instead of scanning
-- to its position. `id` is the primary key, so the pair is unique and no two
-- blogs sharing a title can straddle a page boundary ambiguously.

create index if not exists feeds_export_idx on feeds (title, id);
