/**
 * The one place that decides what a topic is *called*.
 *
 * Many raw category strings slug down to the same topic, so something has to
 * pick the label from among them. Five queries used to pick it independently
 * with `min(keyword)` — the rollup, the topic page, both alert queries and the
 * followed-topics list — and all five were wrong in the same way.
 *
 * `min()` is a *lexicographic* minimum, and in ASCII `!`(0x21) `"`(0x22)
 * `*`(0x2A) `.`(0x2E) `/`(0x2F) `[`(0x5B) and `_`(0x5F) all sort before
 * lowercase letters. So whenever one publisher wrote a malformed `<category>`
 * tag, their spelling won the label for everybody. Measured on prod:
 *
 *   slug `news` displayed as `! news`    — 1 feed, against 10,310 spelling it `news`
 *   slug `en`   displayed as `["en"]`    — 1 feed, against 13,130
 *   slug `ai`   displayed as `"ai"`      — 1 feed, against 11,051
 *   slug `post` displayed as `_posts`    — 1 feed, against 11,774
 *   slug `life` displayed as `/life`     — 4 feeds, against 8,985
 *
 * The old comment on `topicBySlug` explained the choice as "any spelling will
 * do … the rows under one slug differ only in ways the slug already erased".
 * That is the premise that made this invisible, and it is false in exactly one
 * direction: `topicSlug` strips punctuation, `feed_keywords.keyword` keeps it,
 * so the surviving differences are precisely the ugly ones.
 *
 * Ranking by `count(distinct feed_id)` lets the directory's own usage decide.
 * It needs no stoplist, it cannot be captured by a single feed, and it improves
 * on its own as feeds are added. The tie-breaks handle what a count cannot:
 * shortest first, so `ai` beats `ai,` and `ai:` at equal counts, then
 * lexicographic so the result is deterministic.
 *
 * This is a display concern only. `topicSlug` already normalised these away, so
 * URLs, grouping and counts were right the whole time — only the label on top
 * of them was wrong.
 */

/**
 * A correlated scalar subquery returning the most-used spelling of one slug.
 *
 * `slugExpr` is interpolated as SQL, so it must be a column reference the
 * caller controls (`k.slug`, `tf.slug`) — never a value, and never anything
 * derived from user input. Values still go through bound parameters.
 *
 * @param {string} slugExpr SQL expression naming the slug to label
 * @returns {string} SQL scalar subquery
 */
export function topicLabelSql(slugExpr) {
  return `(select lk.keyword
             from feed_keywords lk
            where lk.slug = ${slugExpr}
            group by lk.keyword
            order by count(distinct lk.feed_id) desc, length(lk.keyword) asc, lk.keyword asc
            limit 1)`;
}
