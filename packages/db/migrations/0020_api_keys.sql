-- Keys for the programmatic surface.
--
-- The directory's API stays open: every endpoint answers without a key, because
-- "an open directory of blogs, built for agents" stops being true the moment a
-- reader needs an account to read it. A key does not buy access, it buys a
-- higher rate limit — which is the only thing that is genuinely scarce here,
-- since a crawler and a person cost the same database but not the same number
-- of queries.
--
-- Only the hash is stored, exactly as sessions and sign-in links are stored.
-- The token is shown once, at creation, and is unrecoverable afterwards.
create table if not exists api_keys (
  id           text primary key,
  user_id      text not null references users (id) on delete cascade,
  -- What the key is for, in the owner's words. Keys get revoked one at a time
  -- and nobody can tell two hashes apart.
  name         text not null,
  -- The leading, non-secret part of the token. Enough to recognise a key in a
  -- list and in a log line, useless for presenting back to the server.
  prefix       text not null,
  token_hash   text not null unique,
  hourly_limit integer not null default 5000,
  created_at   text not null,
  last_used_at text,
  -- Revoked rather than deleted: a key that turns up in a log after it stopped
  -- working is a question somebody will want answered.
  revoked_at   text
);

create index if not exists api_keys_user_idx on api_keys (user_id, created_at desc);
