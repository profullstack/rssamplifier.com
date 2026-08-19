-- What a crawl learns about *when to come back*, for the feeds whose documents
-- refuse to say.
--
-- 0030 and cadence.js schedule a feed on its own publishing rhythm, read out of
-- the dates in the document. That works, and it took steady-state demand from
-- ~62,700 crawls an hour to ~2,700. The residue is the feeds that carry no
-- usable dates at all, and measured in production on 2026-08-19 they are the
-- whole remaining problem:
--
--     dated feeds      79,941   avg interval 54,567 min   1,511 crawls/hr
--     undated feeds     1,653   avg interval    105 min   1,183 crawls/hr
--
-- Two percent of the directory asking for forty-four percent of the work, and
-- not because those feeds are busy -- because there is no evidence available
-- about them, so they fall to the old doubling ladder, and the ladder returns to
-- its sixty-minute floor every time a crawl stores anything. A feed whose guids
-- churn stores something every time, so it never leaves the floor. For ever.
--
-- The evidence these columns supply is our own observation instead of the
-- publisher's claim: what the feed's contents were last time, and when we last
-- saw them change. That is enough to run exactly the same rhythm-and-silence
-- calculation on a feed that never states a date, and it costs no extra round
-- trip -- every one of these is written by the update the crawl already makes.

-- HTTP validators, so an unchanged feed can answer 304 and send no body.
--
-- Worth having on its own terms even for dated feeds: the crawler reads ~2,000
-- documents an hour from other people's servers, and a conditional request
-- turns most of those into a header exchange. But the scheduling value is the
-- larger one. A 304 is the publisher stating that nothing has changed, which is
-- strictly better evidence than inferring it from a hash of what they sent, and
-- it arrives without parsing anything.
alter table feeds add column http_etag text;
alter table feeds add column http_last_modified text;

-- A fingerprint of what the feed last contained.
--
-- Over the *identity* of the items -- guid, link, title -- and not their bodies,
-- because the question being asked is "did this publisher publish", and a
-- corrected typo in a post from March is not a publication. Sorted before
-- hashing, so a feed that reorders its entries is not read as having republished
-- all of them.
--
-- This is the fallback for the many servers that send no validators at all; it
-- answers the same question as a 304, one parse later.
alter table feeds add column content_hash text;

-- When we saw the contents change, newest first, as a JSON array of ISO
-- timestamps.
--
-- This is the substitute for publication dates, and it is deliberately a short
-- log on the feed row rather than a table. Cadence needs a handful of recent
-- instants and nothing else; a table would be a join on the hottest write path
-- in the system to store data that is bounded at a dozen strings.
--
-- One observation is already useful, which is the difference between this column
-- and a publication date. A single date in a document tells you when one post
-- went out and nothing about whether another will follow. A single entry here
-- means "it changed then, and we have looked every time since and seen nothing",
-- because the looking is ours -- so silence measured from it is real evidence,
-- and the interval can decay on it without any "is this feed dead" classifier.
alter table feeds add column change_log text;
