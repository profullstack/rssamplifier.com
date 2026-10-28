-- Webhooks move onto @profullstack/webhooks (the fleet's shared hub).
--
-- The two tables are the package's own DDL (`schemaSql('pg')` in 0.2.0),
-- copied here because this app keeps its migrations in one place and the
-- poller applies them on boot. The hub's postgresStore reads and writes them.
create table if not exists webhook_endpoints (
  id text primary key,
  owner text not null,
  url text not null,
  secret text not null,
  events text not null default '["*"]',
  description text not null default '',
  enabled integer not null default 1,
  failures integer not null default 0,
  disabled_reason text,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists webhook_endpoints_owner on webhook_endpoints (owner);
create table if not exists webhook_deliveries (
  id text primary key,
  endpoint_id text not null,
  owner text not null,
  event_id text not null,
  event_type text not null,
  payload text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_at bigint not null,
  last_status integer,
  last_error text,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists webhook_deliveries_due on webhook_deliveries (status, next_at);
create index if not exists webhook_deliveries_endpoint on webhook_deliveries (endpoint_id, created_at);

-- Every existing webhook channel becomes a hub endpoint for the same account,
-- subscribed to every event, keeping its URL, label, on/off state and failure
-- count. The secret keeps its HMAC key bytes: the old sender keyed with the
-- UTF-8 bytes of the string the reader typed, the hub decodes the base64 after
-- `whsec_`, so the string is stored as `whsec_` + base64(utf8(string)) (the
-- same as `legacySecret()` in packages/notify/src/hooks.js; encode() wraps
-- base64 at 76 characters, hence the replace). A channel that had no secret
-- gets a fresh random one: its receiver never checked a signature, and the hub
-- signs everything.
insert into webhook_endpoints
  (id, owner, url, secret, events, description, enabled, failures, disabled_reason, created_at, updated_at)
select
  'wh_' || c.id,
  c.user_id,
  c.target,
  'whsec_' || case
    when coalesce(c.secret::jsonb ->> 'secret', '') <> ''
      then replace(encode(convert_to(c.secret::jsonb ->> 'secret', 'UTF8'), 'base64'), E'\n', '')
    else encode(decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64')
  end,
  '["*"]',
  coalesce(c.label, ''),
  c.enabled::integer,
  c.failures::integer,
  case when c.enabled = 0 and c.failures > 0 then c.last_error end,
  (extract(epoch from c.created_at::timestamptz) * 1000)::bigint,
  (extract(epoch from now()) * 1000)::bigint
from alert_channels c
where c.kind = 'webhook'
on conflict (id) do nothing;

-- The channel rows are gone once their endpoint exists: the sender no longer
-- delivers webhooks from alert_channels, and the account page lists the hub's.
delete from alert_channels
where kind = 'webhook'
  and exists (select 1 from webhook_endpoints w where w.id = 'wh_' || alert_channels.id);
