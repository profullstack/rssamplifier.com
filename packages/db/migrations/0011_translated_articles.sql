-- The translated article, not just its title and summary.
--
-- Translating the title and leaving the post itself in its own language is a
-- half-feature: the reader can now tell what they cannot read. The framed
-- original could never be translated — it is served from somebody else's
-- server — so the reader now renders the post's own stored content instead,
-- translated, and keeps the original one click away in the toolbar.
--
-- Null means "we have a translated title and summary but not a body", which is
-- the state every row written before this migration is in, and also the state
-- of a feed that publishes summaries only. Those rows are not wrong and are
-- not rewritten: the next reader to open one pays for the body, and until then
-- the page shows what it has.

alter table item_translations add column content_html text;

-- Whether the source article was longer than one translation request may
-- carry. The page says so rather than letting a post appear to end early.
alter table item_translations add column truncated integer not null default 0;
