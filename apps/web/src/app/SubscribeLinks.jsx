import { SYNDICATION_FORMATS } from '@rssamplifier/feed';

import { SUBSCRIBE_FORMATS, formatTitle } from '../lib/subscribe.js';

/**
 * The row that says "you can subscribe to this page".
 *
 * Deliberately the same shape as the one the topic pages have carried since
 * they were the only listings with feeds of their own: bare extensions, set
 * quietly under the heading, styled by `.format-links`. A reader who wants a
 * feed knows what `.rss` means and is scanning for exactly that; everybody else
 * should be able to read straight past it.
 *
 * Every format on one line rather than a single RSS link, because the audiences
 * differ and only one of them is a person with a feed reader: `.json` is what an
 * agent takes without an XML parser, `.md` is what it reads without any parser
 * at all, and both are as much the product here as the RSS is.
 *
 * @param {{
 *   base: string,
 *   query?: string,
 *   what: string,
 *   formats?: string[],
 *   label?: string,
 * }} props `base` is the page's path without an extension; `what` is the noun
 *   the title attributes describe, e.g. "this blog".
 */
export default function SubscribeLinks({
  base,
  query = '',
  what,
  formats = SUBSCRIBE_FORMATS,
  label = 'Subscribe:',
}) {
  return (
    <p className="format-links">
      <span>{label}</span>
      {formats.map((ext) => (
        <a
          key={ext}
          href={`${base}.${ext}${query}`}
          title={formatTitle(ext, what)}
          // The advisory type a reader uses to decide it can handle the link
          // before following it. Without the charset: the attribute takes a
          // MIME type, and the parameter belongs on the response header.
          type={SYNDICATION_FORMATS.get(ext)?.type.split(';')[0]}
        >
          {`.${ext}`}
        </a>
      ))}
    </p>
  );
}
