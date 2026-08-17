-- Alerts: being told, rather than having to come back and look.
--
-- Following already answers "collect this for me" — the river at /following and
-- the personal feed behind it. What it never answered is "tell me", and the two
-- are different products: a river is a place you visit, an alert is a thing that
-- arrives. This adds the second without changing the first.
--
-- The shape is deliberately three small pieces rather than one subscriptions
-- table:
--
--   * a flag on the follow, because an alert is a property of something you
--     already follow rather than a separate thing to manage. The control sits
--     next to Follow for the same reason.
--   * channels, because where an alert goes is per-account, not per-follow.
--     Somebody who follows forty blogs wants one email address, not forty.
--   * a watermark and a sent-log, because delivery has to be exactly-once-ish
--     across a daemon that restarts whenever anything deploys.

-- Off by default, on both kinds of follow. A follow made before alerts existed
-- must not start mailing its owner the moment this migration lands, and a new
-- follow is a request to collect, not a request to be interrupted.
alter table follows add column alerts integer not null default 0;
alter table topic_follows add column alerts integer not null default 0;

-- Where one account's alerts go.
--
-- One row per destination, not per (destination, follow): the fan-out is
-- everything alerted × every channel, and pairing them would turn a reader
-- adding a second device into forty new rows.
create table if not exists alert_channels (
  id         text primary key,
  user_id    text not null references users (id) on delete cascade,

  -- 'email' | 'web' | 'webhook'. Kept as text rather than a check constraint:
  -- adding a fourth channel should be a deploy, not a migration.
  kind       text not null,

  -- The address, whatever that means for the kind. An email address, a push
  -- endpoint URL, or a webhook URL. It is also half of the uniqueness key, which
  -- is what stops a browser that re-subscribes from accumulating dead endpoints.
  target     text not null,

  -- The kind's other half, as JSON, or null. For 'web' this is the subscription's
  -- `keys` object ({p256dh, auth}) — without it the endpoint cannot be encrypted
  -- to and is useless. For 'webhook' it is {secret} when the receiver asked to
  -- verify signatures.
  secret     text,

  -- What the reader called it, for telling two devices apart in the UI.
  label      text not null default '',

  -- Switched off keeps the row: a reader silencing their phone for a week should
  -- not have to grant notification permission again afterwards.
  enabled    integer not null default 1,

  created_at text not null,

  -- Delivery health, so a channel that has quietly stopped working can say so on
  -- the account page instead of failing invisibly forever.
  last_ok_at text,
  last_error text,
  -- Consecutive failures. Reset by a success. A channel that has failed enough
  -- times in a row is disabled by the sender rather than retried into the heat
  -- death of the universe — a push endpoint for an uninstalled browser answers
  -- 410 forever.
  failures   integer not null default 0
);

-- One destination per account. A second subscribe from the same browser is the
-- same endpoint, and a reader typing their own address twice meant it once.
create unique index if not exists alert_channels_target_idx
  on alert_channels (user_id, kind, target);

-- The sender's own query: everything one account has switched on.
create index if not exists alert_channels_user_idx on alert_channels (user_id, enabled);

-- How far through the firehose each account has been told about.
--
-- Keyed on feed_items.created_at — when *we* saw a post — rather than
-- published_at, which is what the publisher claims and which a backdated import
-- can set to last year. A watermark on a claimed date would either replay a
-- year of posts or skip a week of them.
create table if not exists alert_state (
  user_id    text primary key references users (id) on delete cascade,
  cursor     text not null,
  updated_at text not null
);

-- What has already been sent, so a restart mid-fan-out does not send it twice.
--
-- The watermark alone is not enough: it only moves once a batch is delivered, and
-- a batch that half-delivered before a SIGTERM would be re-sent from the top. The
-- key is the item's cluster key where it has one, so the same story reaching a
-- reader through two followed feeds is one alert rather than two.
create table if not exists alert_sent (
  user_id  text not null references users (id) on delete cascade,
  item_key text not null,
  sent_at  text not null,

  primary key (user_id, item_key)
);

-- Swept on the same hourly pass as the sessions. Nothing reads a row older than
-- the widest alert window, and without this the table grows for ever.
create index if not exists alert_sent_at_idx on alert_sent (sent_at);
