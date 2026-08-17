-- The reader's own feed, as something a reader app can subscribe to.
--
-- Everything a following river carries is public — it is other people's posts,
-- selected by follows this account made. What is private is the *selection*, so
-- the URL carries a capability: /following.rss?t=<token>, unguessable, and good
-- for nothing else. It cannot sign in, it cannot change a follow, and it reads
-- no field a visitor could not read from the topic pages by hand.
--
-- Stored in the clear, unlike sessions and sign-in links, and the reason is not
-- laziness: a subscription URL has to be displayable again tomorrow, on a second
-- device, without invalidating the copy already pasted into a reader on the
-- first. A hash cannot be shown back. So the mitigation is scope rather than
-- storage — the token grants read of a list of public links, and rotating it
-- from the account page mints a new one and retires the old immediately.

alter table users add column feed_token text;

-- Unique so a token identifies exactly one reader, and the lookup on every feed
-- request is an index seek. SQLite permits any number of nulls in a unique
-- index, which is what lets the column stay empty until somebody asks for a URL.
create unique index if not exists users_feed_token_idx on users (feed_token);
