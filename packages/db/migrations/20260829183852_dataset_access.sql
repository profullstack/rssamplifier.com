-- Paid access to the directory as a training corpus, and the record of who has it.
--
-- Everything the API already serves stays open and needs no account: that
-- promise is written into apps/web/src/lib/apiguard.js and nothing here touches
-- it. A key still buys rate limit rather than access, /api/feeds still answers a
-- stranger, and the MCP server still needs nobody's permission.
--
-- What is being sold is a different artifact. The open API answers questions one
-- at a time — this topic, that feed, the last hundred posts — and is shaped for
-- an agent reading the directory. A training corpus is the opposite shape: every
-- row, in bulk, cut on a boundary you can name and re-fetch, incrementally, for
-- months. Serving that from the open endpoints would be a denial of service
-- against a database whose write path is already its binding constraint, which
-- is why it was never available for free rather than why it is now paid.
--
-- Access is granted by hand, from a conversation that starts at /sales. There is
-- no checkout and no price anywhere in this repository, deliberately: corpus
-- licensing is negotiated per buyer — what they may keep, what they may
-- republish, whether attribution travels with it — and a self-serve button would
-- be selling terms nobody agreed to.

-- ------------------------------------------------------------------ grants
--
-- One row per licensing agreement. Written by an operator after a deal, never by
-- the application, which is why there is no "create grant" endpoint anywhere in
-- the web app: the only way to mint one is a hand-written insert against the
-- production database, and that is the intended amount of friction.
create table if not exists dataset_grants (
  id           text primary key,
  user_id      text not null references users (id) on delete cascade,

  -- The buyer's own label for the agreement, in our words: 'evaluation',
  -- 'research', 'commercial'. Free text rather than a check constraint because
  -- the shape of these deals is not yet known, and a vocabulary guessed now is a
  -- migration later.
  plan         text not null default 'evaluation',

  -- How many times one dataset may be pulled inside a single four-hour window.
  -- Not 1: a dump is a long streamed response, and a connection that dies at
  -- ninety percent must be retryable without waiting four hours for the next
  -- window. Three is enough for a retry and a mistake, and far short of a loop.
  per_window_downloads integer not null default 3,

  -- Full-history pulls per UTC day. The expensive one — it walks the whole of
  -- feed_items rather than one window of it — and the one a buyer needs exactly
  -- once, at the start, before switching to incrementals forever after.
  full_dumps_per_day   integer not null default 1,

  granted_at   text not null,
  -- Null means open-ended. A fixed-term licence sets it and the gate simply
  -- stops opening; nothing has to run for it to expire.
  expires_at   text,
  -- Revoked rather than deleted, for the reason api_keys are: a download that
  -- turns up in the audit log after access ended is a question somebody will
  -- want answered, and the answer needs this row to still exist.
  revoked_at   text,
  note         text
);

create index if not exists dataset_grants_user_idx on dataset_grants (user_id, granted_at desc);

-- ------------------------------------------------------------------ audit
--
-- Every gated byte that left, keyed so the cadence limits above are enforced by
-- counting rows rather than by holding state in a process that gets redeployed
-- mid-window.
--
-- It is also what makes a licence enforceable. "You pulled the full corpus
-- eleven times in March" is only sayable if somebody wrote it down.
create table if not exists dataset_downloads (
  id           text primary key,
  grant_id     text not null references dataset_grants (id) on delete cascade,
  user_id      text not null references users (id) on delete cascade,
  -- Which stream: 'feeds', 'items', 'extracts', 'authors'.
  dataset      text not null,
  -- The four-hour boundary this pull was cut on, or null for a full dump. Two
  -- callers asking for the same window get the same rows, so this identifies an
  -- artifact rather than merely recording a time.
  window_start text,
  -- Set together with a null window_start: the full-history pull.
  full_dump    integer not null default 0,
  -- Which key streamed it, when it was a key rather than a browser session.
  api_key_id   text,

  rows_sent    integer not null default 0,
  -- Written when the stream closes cleanly, so a row with a null completed_at is
  -- a pull that died partway. That is what distinguishes "they took it three
  -- times" from "it broke twice", and it is why the retry allowance above can be
  -- as small as it is.
  completed_at text,
  created_at   text not null
);

create index if not exists dataset_downloads_window_idx
  on dataset_downloads (grant_id, dataset, window_start, created_at desc);
create index if not exists dataset_downloads_daily_idx
  on dataset_downloads (grant_id, created_at desc);

-- ------------------------------------------------------------------ enquiries
--
-- What the form on /sales writes. Stored rather than only emailed, because
-- `sendEmail` reports failure instead of throwing, and a sales enquiry that
-- vanished into a Resend outage is the most expensive message this site can
-- drop.
create table if not exists dataset_enquiries (
  id         text primary key,
  name       text,
  email      text not null,
  org        text,
  -- What they want it for, in their words. The only field that decides anything.
  use_case   text not null,

  -- Salted HMAC, never an address, exactly as `submissions` stores it. Enough to
  -- spot a flood, useless as personal data.
  ip_hash    text,
  user_agent text,
  created_at text not null,
  -- Set by hand when somebody has replied. A queue nobody can see the bottom of
  -- is a queue nobody works.
  handled_at text
);

create index if not exists dataset_enquiries_created_idx on dataset_enquiries (created_at desc);
create index if not exists dataset_enquiries_ip_idx on dataset_enquiries (ip_hash, created_at desc);

-- ------------------------------------------------------------------ opt-out
--
-- A publisher's veto over being sold as training data, separate from being
-- indexed at all.
--
-- The two are genuinely different asks, and conflating them forces a false
-- choice on the one party with the strongest claim here. "Link to my blog in
-- your directory, but do not sell my writing to a model" is a coherent and
-- increasingly common position; without this column the only way to express it
-- is to ask for removal, and the directory loses a good feed over a question it
-- never asked.
--
-- Defaults to 0 because the corpus is built from feeds their publishers chose to
-- syndicate publicly, which is the same basis the directory itself stands on. It
-- is set on request at hello@rssamplifier.com, and honoured by every stream in
-- packages/db/src/dataset.js without exception — including items and extracts,
-- which reach it through the feed a row belongs to rather than carrying their
-- own copy of the flag.
alter table feeds add column dataset_opt_out integer not null default 0;

-- Partial, so it costs a few pages rather than an entry per feed. The question
-- it answers is "who has opted out"; the dump path finds the flag through the
-- feed's primary key instead and needs no index of its own.
create index if not exists feeds_dataset_opt_out_idx
  on feeds (dataset_opt_out) where dataset_opt_out = 1;
