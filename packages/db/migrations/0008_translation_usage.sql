-- A spend ceiling on machine translation.
--
-- Everything else about the feature is already bounded: a translation is cached
-- per (post, language) so repeats are free, the source text is truncated before
-- it is sent, max_tokens bounds the reply, and the language bar only offers a
-- handful of codes. What none of that bounds is how many *distinct* posts one
-- account can ask for. The directory holds ~47k feeds; walking them and asking
-- for each in four languages is a few hundred thousand paid API calls, and
-- nothing above would have said no.
--
-- So: count the calls that actually cost money and stop at a number.
--
-- Two limits, because they stop two different attacks. The per-user limit stops
-- one account walking the catalogue. The global limit stops the obvious answer
-- to that — sign-up is a magic link to any address, so accounts are free to
-- mint — and is the ceiling that actually bounds the bill.
--
-- Only cache misses are counted. Reading a translation somebody else already
-- paid for is free and always stays free, which is what keeps the limit from
-- punishing the readers the feature is for.

create table if not exists translation_usage (
  user_id text not null references users (id) on delete cascade,
  -- UTC date, YYYY-MM-DD. A calendar day rather than a rolling window: the
  -- window would need a row per call to compute, and this needs one row per
  -- reader per day.
  day     text not null,
  count   integer not null default 0,

  primary key (user_id, day)
);

-- The global cap sums a whole day across every reader, so the day has to be the
-- leading column of its own index.
create index if not exists translation_usage_day_idx on translation_usage (day, count);
