-- The episode itself.
--
-- Podcast detection already looked for an audio enclosure and then threw the
-- URL away, so a feed could be filed under /podcasts and have nothing to play.
-- These columns keep what the parser already found.
--
-- Existing rows get null and stay that way until the poller next crawls the
-- feed and re-upserts them; the reader shows a player only where there is one
-- to show, so nothing breaks in the meantime.

alter table feed_items add column audio_url text;
-- The MIME type the publisher declared, passed through to the <source> element
-- so the browser can decide whether it can play it before downloading.
alter table feed_items add column audio_type text;
alter table feed_items add column audio_bytes integer;
-- itunes:duration, in seconds. Lets the page state a running time before the
-- browser has fetched enough of the file to work one out.
alter table feed_items add column audio_seconds integer;
