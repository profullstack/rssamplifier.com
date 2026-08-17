-- Staging for an upload, so that the tab that starts an import does not have to
-- watch it finish.
--
-- The uploader reads a catalogue in the browser and posts the feeds it finds.
-- That was the whole import: each request did the slug lookups and wrote the
-- rows, so a 620,000-entry file meant hundreds of requests of real work and a
-- tab that had to stay open for all of them. What the submitter actually wants
-- is to hand the list over and leave.
--
-- So the posting and the queueing come apart. A request now only records what it
-- was given — no lookups, no slugs, one insert — which is fast enough that
-- handing over a very large catalogue is a minute rather than half an hour. The
-- poller does the rest on its own time, and the submitter is on the status page
-- watching it, or not, as they please.
--
-- Rows are deleted as they drain, so this table is a buffer and not a second
-- copy of the directory.
create table if not exists import_entries (
  id            integer primary key autoincrement,
  submission_id text not null,
  url           text not null,
  title         text,
  site_url      text
);

-- The drain reads one submission's rows in id order and deletes what it took.
create index if not exists import_entries_submission_idx
  on import_entries (submission_id, id);

-- Null until the uploader says it has sent everything. The poller will not
-- touch a submission before then, because a half-sent catalogue drained early
-- would schedule its own tail behind itself.
alter table submissions add column entries_ready_at text;

-- What the uploader counted on its side, so the status page can show progress
-- against the whole file rather than against the part already queued.
alter table submissions add column entries_total integer not null default 0;
