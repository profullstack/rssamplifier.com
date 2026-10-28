import { PLACEHOLDER_SITE, ringEmbed } from '../../lib/ringEmbed.js';
import CopyButton from '../CopyButton.jsx';

/**
 * "Add this ring to your footer": the `<< Ring >>` row, ready to paste, in a
 * plain and a styled variant, with the member's own homepage in every hop.
 *
 * Server-rendered: the site box is a GET form back to the same page, so the
 * snippet is personalised without script; the copy buttons are the only
 * client part.
 *
 * @param {{ base: string, rings: Array<{ slug: string, title: string }>, site: string|null, action: string, idPrefix?: string, siteParam?: string }} props
 */
export default function RingEmbedPanel({ base, rings, site, action, idPrefix = 'embed', siteParam = 'site' }) {
  const plain = ringEmbed({ base, rings, site, style: 'plain' });
  const styled = ringEmbed({ base, rings, site, style: 'styled' });
  const api = `/api/v1/rings/embed?rings=${rings.map((r) => encodeURIComponent(r.slug)).join(',')}${
    site ? `&site=${encodeURIComponent(site)}` : ''
  }`;

  return (
    <div className="ring-embed">
      <form className="submit-box" method="get" action={action}>
        <input
          type="url"
          name={siteParam}
          defaultValue={site ?? ''}
          placeholder={PLACEHOLDER_SITE}
          aria-label="Your site's address"
        />
        <div className="submit-actions">
          <button type="submit">Make my snippet</button>
        </div>
      </form>
      {!site && (
        <p className="hint">
          Put your homepage in the box so <em>previous</em> and <em>next</em> are the sites either
          side of yours. Until then the snippet says <code>{PLACEHOLDER_SITE}</code>.
        </p>
      )}

      <h3>Plain HTML</h3>
      <p className="hint">Bare links; your footer's own styles apply.</p>
      <pre className="code-block" id={`${idPrefix}-plain`}>{plain}</pre>
      <CopyButton target={`${idPrefix}-plain`} />

      <h3>Styled</h3>
      <p className="hint">The same links with inline styles: centred, small, muted. No CSS file needed.</p>
      <pre className="code-block" id={`${idPrefix}-styled`}>{styled}</pre>
      <CopyButton target={`${idPrefix}-styled`} />

      <p className="hint">
        No script, no images, nothing to load. Same snippet over the API: <a href={api}>{api}</a>{' '}
        (add <code>&amp;format=html&amp;style=styled</code> for the raw text), or{' '}
        <code>rssamplifier ring embed {rings.map((r) => r.slug).join(' ')}{site ? ` --site ${site}` : ''}</code>.
      </p>
    </div>
  );
}
