/**
 * Start something in the docked player.
 *
 * An anchor rather than a button, and that is the whole trick: with JavaScript
 * off — or before the dock has hydrated — this is a link to the post, which is
 * a page that plays the thing. With the dock running, the click is taken over
 * and the track starts down at the foot of the window instead, where it will
 * survive everywhere the reader goes next.
 *
 * A post the dock cannot carry gets the same link without the payload: YouTube
 * and PeerTube posts play in their own iframe on their own page, and a play
 * button that quietly does nothing is worse than a link that goes somewhere.
 *
 * @param {{
 *   track: object|null,
 *   lane?: string,
 *   href: string,
 *   label?: string,
 *   className?: string,
 *   resume?: boolean,
 * }} props
 */
export default function PlayButton({
  track,
  lane = 'listen',
  href,
  label = 'Play',
  className,
  resume = false,
}) {
  return (
    <a
      className={className ?? 'play-button'}
      href={track ? String(track.href ?? href) : href}
      // Read by DockPlayer's delegated click handler. Server-rendered as data,
      // so a page listing fifty episodes costs fifty attributes and no
      // components — the dock is the only client code on the site's hot paths.
      data-dock-play={track ? JSON.stringify(track) : undefined}
      data-lane={track ? lane : undefined}
      // "It is already playing in this page — take it with you." The dock reads
      // the position off the inline element rather than starting over.
      data-dock-resume={track && resume ? '' : undefined}
      title={track ? `Play ${String(track.title ?? '')}` : 'Open the post'}
    >
      <span aria-hidden="true">{resume ? '↓' : '▶'}</span>
      <span className="label">{track ? label : 'Open'}</span>
    </a>
  );
}
