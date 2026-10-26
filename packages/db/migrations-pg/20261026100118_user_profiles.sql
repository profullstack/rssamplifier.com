-- The signup profile every Profullstack property keeps: email, first and last
-- name, company domain, job title, LinkedIn URL. The table is the one
-- @profullstack/profile owns (DDL from its `schemaSql({ keyType: 'text' })`),
-- keyed by users.id, which is a text UUID here. No foreign key, as the package
-- documents: deleting a user removes the profile in application code.
--
-- Not `authors`: those are the public writers of feeds in the directory. This
-- is the person who signed up.
create table if not exists "user_profiles" (
  "user_id" text primary key,
  "email" text,
  "first_name" text,
  "last_name" text,
  "company_domain" text,
  "job_title" text,
  "linkedin_url" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index if not exists "user_profiles_email" on "user_profiles" (lower("email"));
create index if not exists "user_profiles_company_domain" on "user_profiles" ("company_domain");

-- The account is only made when the emailed link is followed, so what the
-- signup form collected waits on the link itself, as validated JSON, and is
-- saved once the user row exists. Null for a plain sign-in link.
alter table login_tokens add column if not exists profile text;
