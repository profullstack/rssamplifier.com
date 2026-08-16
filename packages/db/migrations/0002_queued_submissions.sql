-- Large submissions are queued rather than fetched inline.
--
-- Uploading a catalogue used to mean the request tried to resolve every URL in
-- it over the network before answering, so a 47,000-entry OPML returned a few
-- hundred blogs and nothing else was ever stored. Now the first page is
-- resolved while the submitter waits and the remainder is queued for the
-- poller, which needs somewhere to record how much was queued and who to tell
-- when it finishes.

alter table submissions add column queued_count integer not null default 0;

-- Where to send the "your import finished" note. Null means the submitter did
-- not ask to be told, which is the common case and must stay cheap.
alter table submissions add column notify_email text;
alter table submissions add column notified_at text;

-- Which submission queued a feed, so progress can be reported per upload
-- instead of only as a global backlog.
alter table feeds add column submission_id text;

create index if not exists feeds_submission_idx
  on feeds (submission_id) where submission_id is not null;

-- Finding submissions still owed an email is a poller-loop query, so it gets an
-- index rather than a scan of every submission ever made.
create index if not exists submissions_pending_notice_idx
  on submissions (created_at) where notify_email is not null and notified_at is null;
