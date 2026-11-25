-- What a submission found already listed, kept for the "your feed is listed"
-- note (2026-11-25). A feed that was already in the directory is answered from
-- the existing row and never stamped with the new submission's id, so without
-- these the note could neither name the blog it is about nor count it.
--
-- accepted: JSON text, at most twenty entries of { slug, path, existing } for
-- the feeds settled inline; null on rows written before it existed.
-- already_listed: entries of a queued list that were skipped because the
-- directory had them.
alter table submissions add column if not exists accepted text;
alter table submissions add column if not exists already_listed bigint not null default 0;

-- No backfill: a submission from before notices were reworked is never mailed
-- now. One such row was still open in production (2026-08-19, its queue never
-- drained); it is closed as if notified. Idempotent and bounded by date.
update submissions
   set notified_at = created_at
 where notify_email is not null
   and notified_at is null
   and created_at < '2026-11-25';
