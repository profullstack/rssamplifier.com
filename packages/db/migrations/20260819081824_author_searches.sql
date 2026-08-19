-- What we spent looking for people, and on whom.
--
-- Author enrichment reads what publishers put where we could find it, and that
-- is free. Buying a search is not: the credits come from a metered account
-- shared with another product, and the directory is large enough that an
-- unbounded pass would spend a month's allowance in an afternoon.
--
-- A counter in the process would not do. The poller restarts on every deploy,
-- and a budget that resets when the process does is not a budget — it is a
-- rate limit with a hole in it. So the spend is written down, and the ledger is
-- the authority.
--
-- It is also the audit trail, which matters as much. "Which people did we spend
-- money looking for, and did it find anything" is a question worth being able
-- to answer, both to tune the gate that chooses them and to justify the line
-- item.
create table if not exists author_searches (
  id        text primary key,

  -- Null once an author is deleted: the spend still happened, and dropping the
  -- row would make the month's total disagree with what was billed.
  author_id text references authors (id) on delete set null,

  at        text not null,

  -- Credits actually spent, which is not the same as results found. A query
  -- that returns nothing is still billed, and a budget that counted only hits
  -- would overspend precisely on the people who are hardest to find.
  queries   integer not null default 0,

  -- Links stored as a result, so the gate can be judged on its yield rather
  -- than on how it felt.
  found     integer not null default 0
);

-- The only query this table answers in the hot path: how much has been spent
-- since the start of the current billing period.
create index if not exists author_searches_at_idx on author_searches (at);
