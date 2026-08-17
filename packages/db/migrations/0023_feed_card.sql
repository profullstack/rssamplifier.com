-- The one picture that stands for a feed, and how big it actually is.
--
-- Kept apart from feeds.image_url on purpose. That column is what the publisher
-- declared in their feed document; this is the result of going and looking —
-- the site's own og:image where the feed offered nothing, and in both cases a
-- measurement taken from the file's header rather than a guess.
--
-- The size is the point. A URL alone cannot answer the question that kept the
-- feed pages without a social card at all: whether handing it to a crawler
-- produces a card or a 32x32 favicon stretched across somebody's timeline. With
-- the dimensions stored, the page can promise the card and state its size, and
-- the listings can use the same picture as an avatar where the feed had none.

alter table feeds add column card_url text;
alter table feeds add column card_width integer;
alter table feeds add column card_height integer;
-- The image format, as read from the header — not from the content type, which
-- plenty of hosts get wrong. Also the reason a row can be 'ok' and still not be
-- a card: an SVG is a fine avatar and no crawler will render one.
alter table feeds add column card_type text;

-- ok: we have a picture. none: we looked, this publisher offers none — a
-- finding, so the backfill stops asking. error: the look itself failed, which
-- is what a retry is for.
alter table feeds add column card_state text;
alter table feeds add column card_checked_at text;

-- The backfill's work queue, and it shrinks as the work is done: only the rows
-- still wanting an answer are in the index at all. `is not 'ok'` rather than
-- `<> 'ok'` because the column starts null on 52,000 existing rows and a plain
-- <> would exclude every one of them.
--
-- Ordered by when we last looked, nulls first, so never-checked feeds are
-- answered before failures are retried.
create index if not exists feeds_card_due_idx
  on feeds (card_checked_at)
  where card_state is not 'ok';
