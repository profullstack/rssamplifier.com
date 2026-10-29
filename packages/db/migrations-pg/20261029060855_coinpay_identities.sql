-- Sign in with CoinPay. CoinPay is the fleet's master account.
--
-- An account is bound to a CoinPay identity by its `sub` and nothing else.
-- CoinPay does not verify addresses, so the email it shares is kept here as
-- contact information only and never written to users.email: an address here
-- is proven by a link the reader followed, and that stays true.
create table if not exists coinpay_identities (
  sub           text primary key,
  user_id       text not null unique references users (id) on delete cascade,
  email         text,
  name          text,
  created_at    text not null,
  last_login_at text
);

-- One row per authorization request in flight, keyed by the hash of `state`.
-- The PKCE verifier and the nonce never leave the server, and the row is
-- spent by the first callback that presents its state.
create table if not exists coinpay_pending (
  id           text primary key,
  verifier     text not null,
  nonce        text not null,
  next_path    text not null,
  link_user_id text,
  expires_at   text not null,
  created_at   text not null
);
create index if not exists coinpay_pending_expiry_idx on coinpay_pending (expires_at);

-- A sign-in link that, once followed, gives a CoinPay-only account (one still
-- on a coinpay.invalid placeholder) the address the link was mailed to.
alter table login_tokens add column if not exists claim_user_id text;
