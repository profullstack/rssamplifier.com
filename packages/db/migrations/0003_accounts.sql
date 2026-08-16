-- Accounts, so a reader can follow blogs instead of re-finding them.
--
-- There is no password column anywhere in here, and that is deliberate. Signing
-- in starts with a link emailed to the address that proves ownership of it, and
-- from there the reader registers a passkey. A password would be a third
-- credential to phish, reuse and leak, in exchange for nothing the other two do
-- not already cover.

create table if not exists users (
  id            text primary key,
  -- Stored lowercased; the application never compares raw input.
  email         text not null unique,
  created_at    text not null,
  last_login_at text
);

-- A session is the hash of the cookie value, never the value itself: a leaked
-- database backup should not hand over live sessions.
create table if not exists sessions (
  id         text primary key,
  user_id    text not null references users (id) on delete cascade,
  created_at text not null,
  expires_at text not null,
  user_agent text,
  ip_hash    text
);

create index if not exists sessions_user_idx on sessions (user_id);
create index if not exists sessions_expiry_idx on sessions (expires_at);

-- Emailed sign-in links. Hashed for the same reason as sessions, single-use via
-- consumed_at, and short-lived: a link that sits in an inbox forever is a
-- standing key to the account.
create table if not exists login_tokens (
  id          text primary key,
  email       text not null,
  created_at  text not null,
  expires_at  text not null,
  consumed_at text
);

create index if not exists login_tokens_email_idx on login_tokens (email, created_at desc);

-- Registered passkeys. `public_key` is the COSE key as base64url; SQLite would
-- store a blob happily but every other column here is text and the encoding has
-- to survive a JSON round trip through the browser anyway.
create table if not exists credentials (
  id           text primary key,
  user_id      text not null references users (id) on delete cascade,
  public_key   text not null,
  counter      integer not null default 0,
  transports   text not null default '[]',
  device_type  text,
  -- A backed-up credential is one a password manager syncs; worth knowing when
  -- telling someone whether losing a device locks them out.
  backed_up    integer not null default 0,
  name         text,
  created_at   text not null,
  last_used_at text
);

create index if not exists credentials_user_idx on credentials (user_id);

-- WebAuthn challenges live between the options call and the verify call. They
-- are kept server-side and addressed by a handle in a short cookie, so the
-- value the authenticator signs is never something the client chose.
create table if not exists webauthn_challenges (
  id         text primary key,
  challenge  text not null,
  user_id    text,
  purpose    text not null check (purpose in ('register', 'login')),
  created_at text not null,
  expires_at text not null
);

create table if not exists follows (
  user_id    text not null references users (id) on delete cascade,
  feed_id    text not null references feeds (id) on delete cascade,
  created_at text not null,
  primary key (user_id, feed_id)
);

create index if not exists follows_feed_idx on follows (feed_id);
create index if not exists follows_user_idx on follows (user_id, created_at desc);
