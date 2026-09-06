-- The seller side: who may be paid for the writing in this directory.
--
-- The directory is other people's blogs, and traffic_hourly says most of what
-- reads them is machines. crawl_sales says what those machines paid. These
-- three tables are the missing half: which of those publishers has proven a
-- domain, and what share of that money is theirs (@profullstack/partners).
--
-- The DDL matches the package's own sqlStore().schema, and lives here as a
-- numbered migration so it arrives the way every other schema change does.
create table if not exists partner_accounts (
  id             integer primary key autoincrement,
  user_id        text not null unique,
  name           text,
  -- A comma-joined list, the package's storage shape. Nothing here parses it
  -- by hand; every read goes through the package.
  niches         text not null default '',
  payout_address text,
  created_at     integer not null default (cast(strftime('%s','now') as integer) * 1000)
);

-- `domain` is unique across every partner rather than per partner: two
-- accounts claiming one site is the shape of somebody being paid for another
-- person's writing, so the database refuses it rather than the application
-- remembering to.
create table if not exists partner_properties (
  id          integer primary key autoincrement,
  partner_id  text not null,
  domain      text not null unique,
  verified_at integer,
  method      text,
  created_at  integer not null default (cast(strftime('%s','now') as integer) * 1000)
);
create index if not exists partner_properties_partner on partner_properties (partner_id);

-- `ref` is unique so a settlement delivered twice pays once. Credits outlive
-- the property that earned them: removing a site does not erase its earnings.
create table if not exists partner_credits (
  id         integer primary key autoincrement,
  partner_id text not null,
  cents      integer not null,
  ref        text unique,
  at         integer not null
);
create index if not exists partner_credits_partner on partner_credits (partner_id);
