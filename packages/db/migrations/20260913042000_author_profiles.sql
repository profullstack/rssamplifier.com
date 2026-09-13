-- The author's own word over the directory's reading of them.
--
-- Everything on an author page was read off markup the author published, and
-- the OpenProfile.md served beside it (logicsrc.com/openprofile) is generated
-- from the same rows. This table is where the person corrects it: an overlay
-- of identity keys, a headline and sections that win over the generated file
-- (@profullstack/openprofile applyOverrides), and who claimed it, so the
-- directory knows whose word it is.
--
-- One row per author, created on first claim or first edit. No row means the
-- generated file stands as it is, which is the state every author starts in.
create table if not exists author_profiles (
  author_id       text primary key references authors (id) on delete cascade,
  -- JSON: { name?, headline?, prose?, identity?: {key: value|null}, sections?: {name: body} }
  overrides       text not null default '{}',
  -- 0 hides the file (404) without removing the author page; the owner's switch.
  public          integer not null default 1,
  -- Who may edit: a directory account, an OpenAccess principal, or both.
  owner_user_id   text references users (id) on delete set null,
  owner_principal text,
  claimed_at      text,
  -- 'email' (the account's address matched the author's published one),
  -- 'linkback' (their site pointed at this profile), 'admin'.
  claim_method    text,
  updated_at      text not null
);

create index if not exists author_profiles_owner_idx on author_profiles (owner_user_id);
