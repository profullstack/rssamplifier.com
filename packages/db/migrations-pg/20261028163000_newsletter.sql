-- The weekly digest. Every account is on it unless it says otherwise: the
-- owner's decision (2026-10-28) was opted in by default, for the accounts that
-- already exist as much as for new ones, so the column defaults to 1 and
-- adding it fills every existing row with 1. The signup form carries a
-- checkbox (checked) and a reader who unticks it is stored as 0 when the
-- account is made; the account page and the unsubscribe link flip it after.
alter table users add column if not exists newsletter bigint not null default 1;

-- The secret in a reader's unsubscribe link. Random, per account, made the
-- first time a digest is addressed to it, so the link works without a session
-- and without a secret the web and poller services would have to share.
alter table users add column if not exists newsletter_token text;
create unique index if not exists users_newsletter_token_idx on users (newsletter_token);

-- What the signup form said about the digest, riding on the emailed link like
-- the profile does: null for a plain sign-in, 0 or 1 from /signup.
alter table login_tokens add column if not exists newsletter bigint;

-- One row per week (ISO week, '2026-W44'): the issue as built, so every reader
-- of a week gets the same text and the web copy is the mail that went out.
create table if not exists newsletter_issues (
  week        text primary key,
  subject     text not null,
  text        text not null,
  html        text not null,
  data        text not null,
  created_at  text not null,
  finished_at text,
  sent_count  bigint not null default 0
);

-- Who a week has been addressed to. The row is written before the send, so a
-- crash between the two costs a reader one digest, never a second copy.
create table if not exists newsletter_sends (
  week    text not null,
  user_id text not null references users (id) on delete cascade,
  status  text not null check (status in ('sending', 'sent', 'failed')),
  at      text not null,
  error   text,
  primary key (week, user_id)
);
create index if not exists newsletter_sends_user_idx on newsletter_sends (user_id);
