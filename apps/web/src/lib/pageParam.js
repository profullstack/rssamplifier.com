/**
 * A dynamic segment as the database stores it.
 *
 * Next 16 hands a page component its params still percent-encoded, while a
 * route handler gets them decoded. So /情報の灯台 reached the feed page as
 * "%E6%83%85…", matched no slug, and every feed with a non-ASCII slug was a
 * 404 on its own page while /api/feeds/<slug> answered fine (found
 * 2026-10-07). Decoding something that is already decoded is a no-op for any
 * slug without a "%", which none of ours has; a malformed escape is left as is.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function pageParam(raw) {
  const value = String(raw ?? '');
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
