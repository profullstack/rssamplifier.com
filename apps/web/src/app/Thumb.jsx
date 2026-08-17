import { monogram, monogramHue, thumbSrc } from '../lib/thumbs.js';

/**
 * A post's picture, beside the post.
 *
 * A plain `<img>`, deliberately — not `next/image`. The optimizer would resize
 * these on our own server and cache them on a disk that Railway throws away on
 * every deploy, which for a directory whose listings are fifty rows of fifty
 * different hosts is a lot of CPU spent re-fetching other people's pictures.
 * The bytes come from the publisher, as the audio and the framed page already
 * do, and lazy loading means a reader pays only for the rows they scroll to.
 *
 * `alt=""` is not laziness either: the post's title is the next thing in the
 * markup and says the same thing better, so alt text here would be a duplicate
 * read out to every screen reader.
 *
 * And no `width`/`height` attributes, which is the detail that lets this ship
 * without a client-side `onerror` handler. Some fraction of fifty thousand
 * publishers' image URLs is always dead, and a failure has to look like an
 * absence rather than an error: an `<img>` with explicit dimensions that fails
 * to load draws the browser's broken-image icon *even with an empty alt*, while
 * one without them collapses to nothing and leaves the empty tile the design
 * already has. Nothing is lost by dropping them — the wrapper carries a width
 * and an aspect-ratio in the stylesheet, so the row's space is reserved before
 * the bytes arrive either way.
 *
 * @param {{ src?: unknown, href?: string|null, className?: string }} props
 */
export default function Thumb({ src, href = null, className = 'entry-thumb' }) {
  const safe = thumbSrc(src);
  if (!safe) return null;

  const img = <img src={safe} alt="" loading="lazy" decoding="async" />;

  // Clickable, because a picture beside a headline looks clickable and it is
  // the same destination. Hidden from the keyboard and from assistive tech on
  // purpose: it is the row's second link to one place, and an unlabelled
  // duplicate is a tab stop that says nothing.
  return href ? (
    <a className={className} href={href} tabIndex={-1} aria-hidden="true">
      {img}
    </a>
  ) : (
    <span className={className}>{img}</span>
  );
}

/**
 * A feed's cover art beside its name, or its initial where it has none.
 *
 * Three quarters of the blogs here publish no icon at all, so the monogram is
 * the common case rather than the fallback — which is why it is a tinted tile
 * with a letter in it and not a grey placeholder. The tint is derived from the
 * slug, so a feed looks the same on every page it appears on.
 *
 * @param {{ src?: unknown, title?: unknown, slug?: unknown }} props
 */
export function Avatar({ src, title, slug }) {
  const safe = thumbSrc(src);

  if (safe) {
    // The initial goes in behind the picture, in the same grid cell. A cover
    // art URL that has died — and in a directory this size some always have —
    // then reveals a letter rather than an empty box, without the page having to
    // know in advance which URLs are dead. The image carries the tile's own
    // background so a logo with transparency does not show the letter through
    // itself.
    return (
      <span className="feed-avatar">
        <span className="avatar-initial" aria-hidden="true">
          {monogram(title)}
        </span>
        <img src={safe} alt="" loading="lazy" decoding="async" />
      </span>
    );
  }

  return (
    <span
      className="feed-avatar is-monogram"
      style={{ '--monogram-hue': monogramHue(slug ?? title) }}
      aria-hidden="true"
    >
      {monogram(title)}
    </span>
  );
}
