-- rssamplifier.com — PostgreSQL schema.
--
-- This is the SQLite schema (migrations/0001..20260913, applied in order) as
-- one Postgres file. The conventions carried over unchanged, on purpose, so
-- the queries did not have to move with them:
--
--   * Timestamps are ISO-8601 TEXT, as they were. They sort correctly as
--     strings, every comparison in the code is string-shaped, and the few
--     places that did date arithmetic were rewritten (see README.md).
--   * Ids are application-generated text (UUIDs). Integer counters that were
--     SQLite `integer primary key autoincrement` are identity columns.
--   * Flags are integers 0/1, JSON is text. Nothing became boolean or jsonb;
--     the queries cast where they need to.
--   * `feeds`, `feed_items` and `item_extracts` carry a real column named
--     `rowid`: an identity, filled on insert, indexed where the cursors use it.
--     SQLite gave every table an implicit one and the dataset export pages on
--     it; naming the column the same keeps those queries word for word.
--
-- What did not carry over: FTS5. Search is a generated tsvector column with a
-- GIN index on `feeds` and `feed_items` (`search`), and the six triggers that
-- maintained the FTS5 shadow tables are gone with them.

create table if not exists _migrations (
  name       text primary key,
  applied_at text not null
);

-- ------------------------------------------------------------------ users

create table if not exists users (
  id               text primary key,
  email            text not null unique,
  created_at       text not null,
  last_login_at    text,
  reading_language text,
  feed_token       text
);
create unique index if not exists users_feed_token_idx on users (feed_token);

create table if not exists login_tokens (
  id          text primary key,
  email       text not null,
  created_at  text not null,
  expires_at  text not null,
  consumed_at text
);
create index if not exists login_tokens_email_idx on login_tokens (email, created_at desc);

create table if not exists sessions (
  id         text primary key,
  user_id    text not null references users (id) on delete cascade,
  created_at text not null,
  expires_at text not null,
  user_agent text,
  ip_hash    text
);
create index if not exists sessions_expiry_idx on sessions (expires_at);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists credentials (
  id           text primary key,
  user_id      text not null references users (id) on delete cascade,
  public_key   text not null,
  counter      bigint not null default 0,
  transports   text not null default '[]',
  device_type  text,
  backed_up    bigint not null default 0,
  name         text,
  created_at   text not null,
  last_used_at text
);
create index if not exists credentials_user_idx on credentials (user_id);

create table if not exists webauthn_challenges (
  id         text primary key,
  challenge  text not null,
  user_id    text,
  purpose    text not null check (purpose in ('register', 'login')),
  created_at text not null,
  expires_at text not null
);

create table if not exists api_keys (
  id           text primary key,
  user_id      text not null references users (id) on delete cascade,
  name         text not null,
  prefix       text not null,
  token_hash   text not null unique,
  hourly_limit bigint not null default 5000,
  created_at   text not null,
  last_used_at text,
  revoked_at   text
);
create index if not exists api_keys_user_idx on api_keys (user_id, created_at desc);

-- ------------------------------------------------------------------ feeds

create table if not exists submissions (
  id               text primary key,
  kind             text not null check (kind in ('url', 'list', 'opml')),
  raw_input        text,
  accepted_count   bigint not null default 0,
  rejected_count   bigint not null default 0,
  errors           text not null default '[]',
  ip_hash          text,
  user_agent       text,
  created_at       text not null,
  queued_count     bigint not null default 0,
  notify_email     text,
  notified_at      text,
  entries_ready_at text,
  entries_total    bigint not null default 0
);
create index if not exists submissions_created_idx on submissions (created_at desc);
create index if not exists submissions_ip_idx on submissions (ip_hash, created_at desc);
create index if not exists submissions_pending_notice_idx
  on submissions (created_at) where notify_email is not null and notified_at is null;

create table if not exists import_entries (
  id            bigint generated always as identity primary key,
  submission_id text not null,
  url           text not null,
  title         text,
  site_url      text
);
create index if not exists import_entries_submission_idx on import_entries (submission_id, id);

create table if not exists discovery_runs (
  id              text primary key,
  keywords        text not null default '[]',
  keyword_count   bigint not null default 0,
  status          text not null default 'running'
                  check (status in ('running', 'queued', 'complete', 'failed')),
  provider        text not null default 'valueserp',
  error           text,
  searched_count  bigint not null default 0,
  candidate_count bigint not null default 0,
  accepted_count  bigint not null default 0,
  rejected_count  bigint not null default 0,
  queued_count    bigint not null default 0,
  notify_email    text,
  notified_at     text,
  ip_hash         text,
  user_agent      text,
  created_at      text not null,
  updated_at      text not null,
  completed_at    text,
  category        text,
  curated         bigint not null default 0
);
create index if not exists discovery_runs_created_idx on discovery_runs (created_at desc);
create index if not exists discovery_runs_pending_notice_idx
  on discovery_runs (created_at) where notify_email is not null and notified_at is null;
create index if not exists discovery_runs_provider_idx on discovery_runs (provider, created_at desc);

create table if not exists feeds (
  rowid                  bigint generated always as identity,
  id                     text primary key,
  slug                   text not null unique,
  feed_url               text not null unique,
  site_url               text,
  title                  text not null,
  description            text,
  language               text,
  image_url              text,
  author                 text,
  categories             text not null default '[]',
  status                 text not null default 'pending'
                         check (status in ('pending', 'active', 'error', 'dead')),
  last_fetched_at        text,
  last_success_at        text,
  last_error             text,
  error_count            bigint not null default 0,
  fetch_interval_minutes bigint not null default 60,
  next_fetch_at          text not null,
  item_count             bigint not null default 0,
  created_at             text not null,
  updated_at             text not null,
  submission_id          text,
  kind                   text not null default 'blog' check (kind in ('blog', 'podcast')),
  category               text not null default 'blog',
  category_source        text not null default 'derived' check (category_source in ('derived', 'curated')),
  discovery_run_id       text,
  source_kind            text not null default 'feed' check (source_kind in ('feed', 'scraped')),
  card_url               text,
  card_width             bigint,
  card_height            bigint,
  card_type              text,
  card_state             text,
  card_checked_at        text,
  authors_checked_at     text,
  last_published_at      text,
  http_etag              text,
  http_last_modified     text,
  content_hash           text,
  change_log             text,
  priority               bigint not null default 0,
  social_network         text,
  social_ref             text,
  social_config          text,
  dataset_opt_out        bigint not null default 0,
  search tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) stored
);
create unique index if not exists feeds_rowid_idx on feeds (rowid);
create index if not exists feeds_search_idx on feeds using gin (search);
create index if not exists feeds_authors_due_idx on feeds (authors_checked_at) where status = 'active';
create index if not exists feeds_card_due_idx on feeds (card_checked_at) where card_state is distinct from 'ok';
create index if not exists feeds_card_state_idx on feeds (card_state, card_checked_at);
create index if not exists feeds_category_created_idx
  on feeds (category, created_at desc, id desc) where status <> 'dead';
create index if not exists feeds_created_idx on feeds (created_at desc);
create index if not exists feeds_dataset_opt_out_idx on feeds (dataset_opt_out) where dataset_opt_out = 1;
create index if not exists feeds_discovery_run_idx on feeds (discovery_run_id) where discovery_run_id is not null;
create index if not exists feeds_due_idx on feeds (next_fetch_at) where status <> 'dead';
create index if not exists feeds_due_kind_idx on feeds (next_fetch_at, source_kind) where status <> 'dead';
create index if not exists feeds_export_idx on feeds (title, id);
create index if not exists feeds_fetched_at_idx on feeds (last_fetched_at);
create index if not exists feeds_kind_created_idx
  on feeds (kind, created_at desc, id desc) where status <> 'dead';
create index if not exists feeds_language_idx on feeds (language) where language is not null;
create index if not exists feeds_last_published_idx on feeds (last_published_at) where last_published_at is not null;
create index if not exists feeds_sitemap_idx on feeds (created_at, id);
create index if not exists feeds_social_network_idx
  on feeds (social_network, created_at desc) where social_network is not null;
create unique index if not exists feeds_social_ref_idx on feeds (social_ref) where social_ref is not null;
create index if not exists feeds_status_idx on feeds (status);
create index if not exists feeds_status_success_idx on feeds (status, last_success_at);
create index if not exists feeds_submission_idx on feeds (submission_id) where submission_id is not null;
create index if not exists idx_feeds_express on feeds (next_fetch_at) where priority > 0 and last_fetched_at is null;

create table if not exists feed_items (
  rowid          bigint generated always as identity,
  id             text primary key,
  feed_id        text not null references feeds (id) on delete cascade,
  guid           text not null,
  url            text,
  title          text not null,
  summary        text,
  content_html   text,
  author         text,
  image_url      text,
  published_at   text,
  created_at     text not null,
  categories     text not null default '[]',
  audio_url      text,
  audio_type     text,
  audio_bytes    bigint,
  audio_seconds  bigint,
  cluster_key    text,
  content_chars  bigint,
  search tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))
  ) stored,
  unique (feed_id, guid)
);
create unique index if not exists feed_items_rowid_idx on feed_items (rowid);
create index if not exists feed_items_search_idx on feed_items using gin (search);
create index if not exists feed_items_created_idx on feed_items (created_at, rowid);
create index if not exists feed_items_feed_pub_idx on feed_items (feed_id, published_at desc);
create index if not exists feed_items_pub_idx on feed_items (published_at desc);

create table if not exists item_extracts (
  rowid        bigint generated always as identity,
  item_id      text primary key references feed_items (id) on delete cascade,
  url          text not null,
  title        text,
  byline       text,
  excerpt      text,
  site_name    text,
  content_html text,
  text_length  bigint not null default 0,
  status       text not null check (status in ('ok', 'empty', 'blocked', 'error')),
  reason       text,
  fetched_at   text not null
);
create unique index if not exists item_extracts_rowid_idx on item_extracts (rowid);
create index if not exists item_extracts_fetched_idx on item_extracts (status, fetched_at, rowid);

create table if not exists item_translations (
  item_id      text not null references feed_items (id) on delete cascade,
  lang         text not null,
  title        text not null,
  summary      text,
  model        text not null,
  source_lang  text,
  created_at   text not null,
  content_html text,
  truncated    bigint not null default 0,
  primary key (item_id, lang)
);

create table if not exists translation_usage (
  user_id text not null references users (id) on delete cascade,
  day     text not null,
  count   bigint not null default 0,
  primary key (user_id, day)
);
create index if not exists translation_usage_day_idx on translation_usage (day, count);

create table if not exists feed_keywords (
  feed_id text not null references feeds (id) on delete cascade,
  slug    text not null,
  keyword text not null,
  words   bigint not null default 1,
  count   bigint not null default 0,
  source  text not null default 'content' check (source in ('content', 'category')),
  primary key (feed_id, slug)
);
create index if not exists feed_keywords_slug_idx on feed_keywords (slug, count desc);

create table if not exists topics (
  slug         text primary key,
  keyword      text not null,
  feed_count   bigint not null default 0,
  refreshed_at text not null
);
create index if not exists topics_popular_idx on topics (feed_count desc, slug);

create table if not exists feed_links (
  id         text primary key,
  feed_id    text not null references feeds (id) on delete cascade,
  network    text not null,
  url        text not null,
  handle     text,
  source     text not null,
  verified   bigint not null default 0,
  created_at text not null,
  unique (feed_id, url)
);
create index if not exists feed_links_feed_idx on feed_links (feed_id);
create index if not exists feed_links_network_idx on feed_links (network);

create table if not exists feed_removals (
  id            text primary key,
  feed_url      text not null unique,
  host          text not null,
  slug          text,
  title         text,
  reason        text,
  requested_by  text,
  items_removed bigint not null default 0,
  created_at    text not null
);
create index if not exists feed_removals_host_idx on feed_removals (host);

-- --------------------------------------------------------------- discovery

create table if not exists discovery_keywords (
  id           text primary key,
  run_id       text not null references discovery_runs (id) on delete cascade,
  keyword      text not null,
  status       text not null default 'queued' check (status in ('queued', 'searched', 'failed')),
  result_count bigint,
  error        text,
  created_at   text not null,
  searched_at  text,
  unique (run_id, keyword)
);
create index if not exists discovery_keywords_queued_idx on discovery_keywords (created_at) where status = 'queued';
create index if not exists discovery_keywords_run_idx on discovery_keywords (run_id, status);

create table if not exists discovery_candidates (
  id         text primary key,
  run_id     text not null references discovery_runs (id) on delete cascade,
  keyword    text,
  site_url   text not null,
  host       text not null,
  status     text not null default 'queued' check (status in ('queued', 'accepted', 'rejected', 'error')),
  feed_url   text,
  slug       text,
  score      bigint,
  reason     text,
  created_at text not null,
  checked_at text,
  unique (run_id, host)
);
create index if not exists discovery_candidates_queued_idx on discovery_candidates (created_at) where status = 'queued';
create index if not exists discovery_candidates_run_idx on discovery_candidates (run_id, status);

-- ----------------------------------------------------------------- authors

create table if not exists authors (
  id            text primary key,
  slug          text not null unique,
  identity_key  text not null unique,
  name          text not null,
  norm_name     text not null,
  bio           text,
  avatar_url    text,
  site_url      text,
  email         text,
  confidence    double precision not null default 0,
  created_at    text not null,
  updated_at    text not null
);
create index if not exists authors_confidence_idx on authors (confidence desc);
create index if not exists authors_norm_name_idx on authors (norm_name);

create table if not exists author_links (
  id         text primary key,
  author_id  text not null references authors (id) on delete cascade,
  network    text not null,
  url        text not null,
  handle     text,
  source     text not null,
  verified   bigint not null default 0,
  created_at text not null,
  unique (author_id, url)
);
create index if not exists author_links_author_idx on author_links (author_id);
create index if not exists author_links_network_idx on author_links (network);

create table if not exists author_profiles (
  author_id       text primary key references authors (id) on delete cascade,
  overrides       text not null default '{}',
  public          bigint not null default 1,
  owner_user_id   text references users (id) on delete set null,
  owner_principal text,
  claimed_at      text,
  claim_method    text,
  updated_at      text not null
);
create index if not exists author_profiles_owner_idx on author_profiles (owner_user_id);

create table if not exists author_searches (
  id        text primary key,
  author_id text references authors (id) on delete set null,
  at        text not null,
  queries   bigint not null default 0,
  found     bigint not null default 0
);
create index if not exists author_searches_at_idx on author_searches (at);

create table if not exists feed_authors (
  feed_id    text not null references feeds (id) on delete cascade,
  author_id  text not null references authors (id) on delete cascade,
  role       text not null default 'author',
  confidence double precision not null default 0,
  evidence   text,
  created_at text not null,
  primary key (feed_id, author_id)
);
create index if not exists feed_authors_author_idx on feed_authors (author_id);

create table if not exists author_follows (
  user_id    text not null references users (id) on delete cascade,
  author_id  text not null references authors (id) on delete cascade,
  alerts     bigint not null default 0,
  created_at text not null,
  primary key (user_id, author_id)
);
create index if not exists author_follows_author_idx on author_follows (author_id);
create index if not exists author_follows_user_idx on author_follows (user_id, created_at desc);

-- ----------------------------------------------------------- reader state

create table if not exists follows (
  user_id    text not null references users (id) on delete cascade,
  feed_id    text not null references feeds (id) on delete cascade,
  created_at text not null,
  alerts     bigint not null default 0,
  primary key (user_id, feed_id)
);
create index if not exists follows_feed_idx on follows (feed_id);
create index if not exists follows_user_idx on follows (user_id, created_at desc);

create table if not exists topic_follows (
  user_id    text not null references users (id) on delete cascade,
  slug       text not null,
  segment    text not null default '',
  created_at text not null,
  alerts     bigint not null default 0,
  primary key (user_id, slug, segment)
);
create index if not exists topic_follows_slug_idx on topic_follows (slug, segment);
create index if not exists topic_follows_user_idx on topic_follows (user_id, created_at desc);

create table if not exists post_reactions (
  user_id    text not null references users (id) on delete cascade,
  item_id    text not null references feed_items (id) on delete cascade,
  liked      bigint not null default 0 check (liked in (0, 1)),
  vote       bigint not null default 0 check (vote in (-1, 0, 1)),
  created_at text not null,
  updated_at text not null,
  primary key (user_id, item_id)
);
create index if not exists post_reactions_item_idx on post_reactions (item_id) where vote <> 0;
create index if not exists post_reactions_liked_idx on post_reactions (user_id, updated_at desc) where liked = 1;

create table if not exists comments (
  id         text primary key,
  item_id    text not null references feed_items (id) on delete cascade,
  user_id    text not null references users (id) on delete cascade,
  body       text not null,
  created_at text not null,
  deleted_at text
);
create index if not exists comments_item_idx on comments (item_id, created_at);
create index if not exists comments_user_idx on comments (user_id, created_at desc);

create table if not exists queue_entries (
  id       text primary key,
  user_id  text not null references users (id) on delete cascade,
  item_id  text not null references feed_items (id) on delete cascade,
  lane     text not null check (lane in ('read', 'listen', 'watch')),
  position bigint not null,
  added_at text not null,
  done_at  text
);
create index if not exists queue_entries_done_idx on queue_entries (user_id, done_at desc) where done_at is not null;
create index if not exists queue_entries_item_idx on queue_entries (user_id, item_id);
create index if not exists queue_entries_lane_idx on queue_entries (user_id, lane, position) where done_at is null;
create unique index if not exists queue_entries_unique_idx on queue_entries (user_id, lane, item_id);

-- ------------------------------------------------------------------ alerts

create table if not exists alert_channels (
  id         text primary key,
  user_id    text not null references users (id) on delete cascade,
  kind       text not null,
  target     text not null,
  secret     text,
  label      text not null default '',
  enabled    bigint not null default 1,
  created_at text not null,
  last_ok_at text,
  last_error text,
  failures   bigint not null default 0
);
create unique index if not exists alert_channels_target_idx on alert_channels (user_id, kind, target);
create index if not exists alert_channels_user_idx on alert_channels (user_id, enabled);

create table if not exists alert_sent (
  user_id  text not null references users (id) on delete cascade,
  item_key text not null,
  sent_at  text not null,
  primary key (user_id, item_key)
);
create index if not exists alert_sent_at_idx on alert_sent (sent_at);

create table if not exists alert_state (
  user_id    text primary key references users (id) on delete cascade,
  cursor     text not null,
  updated_at text not null
);

-- ----------------------------------------------------------------- dataset

create table if not exists dataset_grants (
  id                   text primary key,
  user_id              text not null references users (id) on delete cascade,
  plan                 text not null default 'evaluation',
  per_window_downloads bigint not null default 3,
  full_dumps_per_day   bigint not null default 1,
  granted_at           text not null,
  expires_at           text,
  revoked_at           text,
  note                 text
);
create index if not exists dataset_grants_user_idx on dataset_grants (user_id, granted_at desc);

create table if not exists dataset_downloads (
  id           text primary key,
  grant_id     text not null references dataset_grants (id) on delete cascade,
  user_id      text not null references users (id) on delete cascade,
  dataset      text not null,
  window_start text,
  full_dump    bigint not null default 0,
  api_key_id   text,
  rows_sent    bigint not null default 0,
  completed_at text,
  created_at   text not null
);
create index if not exists dataset_downloads_daily_idx on dataset_downloads (grant_id, created_at desc);
create index if not exists dataset_downloads_window_idx
  on dataset_downloads (grant_id, dataset, window_start, created_at desc);

create table if not exists dataset_enquiries (
  id         text primary key,
  name       text,
  email      text not null,
  org        text,
  use_case   text not null,
  ip_hash    text,
  user_agent text,
  created_at text not null,
  handled_at text
);
create index if not exists dataset_enquiries_created_idx on dataset_enquiries (created_at desc);
create index if not exists dataset_enquiries_ip_idx on dataset_enquiries (ip_hash, created_at desc);

-- -------------------------------------------------------------- operations

create table if not exists crawl_hourly (
  hour      text primary key,
  ticks     bigint not null default 0,
  fetched   bigint not null default 0,
  succeeded bigint not null default 0,
  failed    bigint not null default 0,
  items     bigint not null default 0
);

create table if not exists crawl_log (
  id      bigint generated always as identity primary key,
  at      text not null,
  event   text not null,
  status  text,
  subject text,
  slug    text,
  amount  bigint,
  detail  text,
  ms      bigint
);
create index if not exists crawl_log_at_idx on crawl_log (at);

create table if not exists queue_hourly (
  hour        text primary key,
  at          text not null,
  due         bigint not null default 0,
  first_crawl bigint not null default 0,
  cards       bigint not null default 0,
  authors     bigint not null default 0
);

create table if not exists traffic_hourly (
  hour    text not null,
  agent   text not null,
  bucket  text not null,
  tier    text not null,
  hits    bigint not null default 0,
  refused bigint not null default 0,
  primary key (hour, agent, bucket, tier)
);
create index if not exists traffic_hourly_hour on traffic_hourly (hour);

create table if not exists x_provider_state (
  provider             text primary key,
  status               text not null default 'unknown',
  last_success_at      text,
  last_failure_at      text,
  consecutive_failures bigint not null default 0,
  cooldown_until       text,
  error_message        text
);

create table if not exists x_sessions (
  id                   text primary key,
  status               text not null default 'healthy',
  cooldown_until       text,
  last_used_at         text,
  consecutive_failures bigint not null default 0,
  last_error           text
);

-- ------------------------------------------------------------------- money

create table if not exists crawl_sales (
  id          bigint generated always as identity primary key,
  payer       text,
  ref         text unique,
  days        bigint not null default 1,
  price_cents bigint not null default 0,
  total_cents bigint not null default 0,
  currency    text not null default 'USD',
  user_agent  text,
  agent       text,
  expires_at  text,
  created_at  text not null
);
create index if not exists crawl_sales_created on crawl_sales (created_at);
create index if not exists crawl_sales_payer on crawl_sales (payer, created_at);

create table if not exists leaderboard_badges (
  player     text not null,
  badge      text not null,
  awarded_at text not null,
  primary key (player, badge)
);

-- The partner tables keep their epoch-millisecond integers.
create table if not exists partner_accounts (
  id             bigint generated always as identity primary key,
  user_id        text not null unique,
  name           text,
  niches         text not null default '',
  payout_address text,
  created_at     bigint not null default (floor(extract(epoch from now()) * 1000)::bigint)
);

create table if not exists partner_credits (
  id         bigint generated always as identity primary key,
  partner_id text not null,
  cents      bigint not null,
  ref        text unique,
  at         bigint not null
);
create index if not exists partner_credits_partner on partner_credits (partner_id);

create table if not exists partner_properties (
  id          bigint generated always as identity primary key,
  partner_id  text not null,
  domain      text not null unique,
  verified_at bigint,
  method      text,
  created_at  bigint not null default (floor(extract(epoch from now()) * 1000)::bigint)
);
create index if not exists partner_properties_partner on partner_properties (partner_id);

-- ---------------------------------------------------------------- webrings

create table if not exists rings (
  slug        text primary key,
  title       text not null,
  description text,
  kind        text not null check (kind in ('topic', 'curated')),
  topic_slug  text,
  accepts     text,
  public      bigint not null default 1,
  created_at  text not null,
  updated_at  text not null,
  owner_id    text
);
create index if not exists rings_owner_idx on rings (owner_id);

create table if not exists ring_members (
  ring_slug      text not null references rings (slug) on delete cascade,
  feed_id        text not null references feeds (id) on delete cascade,
  member_slug    text not null,
  position       bigint not null,
  site_url       text not null,
  made_by        text check (made_by in ('human', 'ai', 'both')),
  made_by_source text check (made_by_source in ('descriptor', 'owner', 'admin')),
  disclosure     text,
  descriptor_url text,
  status         text not null default 'pending' check (status in ('active', 'inactive', 'pending')),
  checked_at     text,
  joined_at      text not null,
  primary key (ring_slug, feed_id),
  unique (ring_slug, position),
  unique (ring_slug, member_slug)
);
create index if not exists ring_members_order_idx on ring_members (ring_slug, position);

create table if not exists ring_likes (
  ring_slug  text not null,
  user_id    text not null references users (id) on delete cascade,
  created_at text not null,
  primary key (ring_slug, user_id)
);
create index if not exists ring_likes_user_idx on ring_likes (user_id);

create table if not exists ring_events (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('view', 'share', 'like', 'follow', 'add', 'make')),
  ring_slug   text not null,
  member_slug text,
  user_id     text references users (id) on delete cascade,
  created_at  text not null
);
create index if not exists ring_events_at_idx on ring_events (created_at);
create index if not exists ring_events_ring_idx on ring_events (ring_slug, created_at);
create index if not exists ring_events_user_idx on ring_events (user_id, created_at);
