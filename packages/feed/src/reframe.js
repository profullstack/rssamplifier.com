import { parseHTML } from 'linkedom';

/**
 * Make a framed page's own links work.
 *
 * The reader frames the publisher's page, and until now it framed it straight
 * from their server. That works exactly once. Every link inside the frame is a
 * link the browser loads *into the frame*, and the moment it points at a site
 * with X-Frame-Options or a frame-ancestors policy — which is most of the web —
 * the reader gets "refused to connect" in the rectangle they were reading in.
 * A post about Claude Code linking to code.claude.com is enough to hit it, and
 * nothing on our side can see it happen: a cross-origin frame reports neither
 * its location nor a failed load.
 *
 * So the document is served from our origin instead of theirs, which is the
 * only way its links can be ours to point somewhere that works. Everything
 * else still comes from the publisher: the `<base>` left in the head means
 * their stylesheets, images, fonts and scripts load from their server exactly
 * as before, and only the HTML itself takes the detour.
 *
 * This is done only for pages that already said anyone may frame them. A site
 * that refuses framing is refusing, and the reader answers that the way it
 * always has — by reading the page and rendering the article. Serving a
 * refusing site's page from here would be routing around a "no", and the
 * reader does not do that.
 */

/** Schemes that are not navigation and must be left exactly as the author wrote them. */
const OPAQUE = new Set(['javascript:', 'data:', 'blob:', 'about:']);

/** Schemes that leave the browser entirely; they only need to escape the frame. */
const HANDOFF = new Set(['mailto:', 'tel:', 'sms:', 'magnet:']);

/**
 * Rewrite a fetched page so it can be read, and navigated, inside the frame.
 *
 * No network and no I/O: hand it markup and it hands back markup, which is
 * what makes the interesting half of this testable.
 *
 * @param {string} html the page source, as fetched
 * @param {{
 *   url: string,
 *   self: string,
 *   through: (url: string) => string,
 *   origin?: string,
 * }} options
 *   `url` is where the page was fetched from after redirects — what relative
 *   URLs resolve against. `self` is the address this rewritten copy is served
 *   at, which is what a bare `#anchor` has to point at to stay an anchor.
 *   `through` turns an absolute URL into the address that reads it here.
 * @returns {string}
 */
export function reframePage(html, options) {
  const { url, self, through, origin } = options;
  const source = String(html ?? '');
  if (!source.trim()) return source;

  let document;
  try {
    ({ document } = parseHTML(source));
  } catch {
    // A page we cannot parse is one we cannot rewrite, and handing back the
    // original at least renders. Its links will misbehave the old way rather
    // than not exist.
    return source;
  }

  const head = ensureHead(document);
  const base = declaredBase(document, url);

  setBase(document, head, base);
  dropMetaPolicy(head);
  redirectMetaRefresh(head, base, through);

  for (const link of document.querySelectorAll('a[href]')) rewriteLink(link, base, self, through);
  for (const form of document.querySelectorAll('form')) escapeForm(form, base);

  announce(document, head, url, origin);

  const out = document.toString();
  return /^\s*<!doctype/i.test(out) ? out : `<!doctype html>\n${out}`;
}

/**
 * The URL relative links resolve against: the page's own `<base>` if it set
 * one, since that is what a browser would honour, and where it was fetched
 * from otherwise.
 *
 * @param {Document} document
 * @param {string} url
 * @returns {string}
 */
function declaredBase(document, url) {
  const declared = document.querySelector('base[href]')?.getAttribute('href');
  if (!declared) return url;
  return absolute(declared, url) ?? url;
}

/**
 * Keep a `<base>` pointing at the publisher.
 *
 * This is the tag that makes the page still look like theirs. Without it every
 * relative `/css/site.css` and `/images/hero.jpg` would resolve against
 * rssamplifier.com and 404, and the reader would get the publisher's article
 * with none of the publisher's design.
 *
 * @param {Document} document
 * @param {Element} head
 * @param {string} base
 */
function setBase(document, head, base) {
  const existing = document.querySelector('base');
  if (existing) {
    existing.setAttribute('href', base);
    return;
  }
  const tag = document.createElement('base');
  tag.setAttribute('href', base);
  head.insertBefore(tag, head.firstChild);
}

/**
 * Drop a `<meta>` Content-Security-Policy.
 *
 * It was written for the publisher's origin against a document they served.
 * This copy is served from ours into a sandbox with no origin at all, so the
 * policy no longer describes anything true — and a `script-src` in it would
 * block the one line below that tells the toolbar where the reader has got to.
 * The response carries its own policy, which is the one that matters.
 *
 * @param {Element} head
 */
function dropMetaPolicy(head) {
  for (const meta of head.querySelectorAll('meta[http-equiv]')) {
    const name = String(meta.getAttribute('http-equiv') ?? '').toLowerCase();
    if (name === 'content-security-policy') meta.remove();
  }
}

/**
 * Send a `<meta refresh>` through the reader like any other navigation.
 *
 * A page that bounces itself somewhere else would otherwise bounce the frame
 * straight into the refusal this whole file exists to avoid.
 *
 * @param {Element} head
 * @param {string} base
 * @param {(url: string) => string} through
 */
function redirectMetaRefresh(head, base, through) {
  for (const meta of head.querySelectorAll('meta[http-equiv]')) {
    if (String(meta.getAttribute('http-equiv') ?? '').toLowerCase() !== 'refresh') continue;

    const content = String(meta.getAttribute('content') ?? '');
    const match = /^\s*([\d.]+)\s*;\s*url\s*=\s*['"]?([^'"]+)['"]?\s*$/i.exec(content);
    if (!match) continue;

    const target = absolute(match[2], base);
    if (!target || !isHttp(target)) continue;

    meta.setAttribute('content', `${match[1]};url=${through(target)}`);
  }
}

/**
 * Point one link at whatever will actually open.
 *
 * @param {Element} link
 * @param {string} base
 * @param {string} self
 * @param {(url: string) => string} through
 */
function rewriteLink(link, base, self, through) {
  const href = String(link.getAttribute('href') ?? '').trim();
  if (!href) return;

  // An in-page anchor has to keep addressing this document, and this document
  // is served at `self`, not at the publisher's URL. Left alone it would
  // resolve against the `<base>` and reload the whole page from the top.
  if (href.startsWith('#')) {
    link.setAttribute('href', `${self}${href}`);
    return;
  }

  const scheme = schemeOf(href);

  // Not a navigation. `javascript:` is the page's own business, and rewriting
  // it would break it.
  if (scheme && OPAQUE.has(scheme)) return;

  // Leaves the browser: it only needs to not do so inside a sandboxed frame,
  // where the handler never opens.
  if (scheme && HANDOFF.has(scheme)) {
    link.setAttribute('target', '_blank');
    return;
  }

  const target = String(link.getAttribute('target') ?? '')
    .trim()
    .toLowerCase();

  // The author already said "somewhere else": honour it, and let it be the
  // publisher's own page in a real tab rather than a copy of it in here.
  if (target === '_blank' || target === '_new') {
    link.setAttribute('rel', withNoopener(link.getAttribute('rel')));
    return;
  }

  const absoluteHref = absolute(href, base);
  if (!absoluteHref || !isHttp(absoluteHref)) return;

  // `_top` and `_parent` are a framebusting link trying to replace the reader
  // itself. The sandbox already refuses it, which makes the link do nothing at
  // all — worse than either outcome. Aim it at the frame, where it works.
  if (target === '_top' || target === '_parent') link.setAttribute('target', '_self');

  link.setAttribute('href', through(absoluteHref));
}

/**
 * Submit forms in a real tab, on the publisher's own site.
 *
 * A search box is the common case, and a relative action would post it to
 * rssamplifier.com, which has no idea what to do with it. Sending it out to a
 * tab keeps it working, keeps the reader's place, and avoids the reader
 * becoming a relay for someone else's POST.
 *
 * @param {Element} form
 * @param {string} base
 */
function escapeForm(form, base) {
  const action = String(form.getAttribute('action') ?? '').trim();
  const resolved = action ? absolute(action, base) : base;
  if (resolved && isHttp(resolved)) form.setAttribute('action', resolved);
  form.setAttribute('target', '_blank');
}

/**
 * Tell the reader where the frame has got to.
 *
 * Once links work, the reader can be three pages deep in a blog's archive
 * while the toolbar's "Open ↗" still points at the post they started on. The
 * frame has no origin, so it cannot touch the toolbar directly; it can post a
 * message, and one line is enough.
 *
 * First in the head on purpose: whatever the publisher's own scripts do, and
 * however they fail in a sandbox, this has already run.
 *
 * @param {Document} document
 * @param {Element} head
 * @param {string} url
 * @param {string} [origin]
 */
function announce(document, head, url, origin) {
  const tag = document.createElement('script');
  const payload = JSON.stringify({ source: 'rssamplifier-reader', url });
  const to = JSON.stringify(origin ?? '*');
  tag.textContent = `try{parent.postMessage(${payload},${to})}catch(e){}`;
  head.insertBefore(tag, head.firstChild);
}

/**
 * @param {Document} document
 * @returns {Element}
 */
function ensureHead(document) {
  const existing = document.querySelector('head');
  if (existing) return existing;

  const head = document.createElement('head');
  const html = document.querySelector('html');
  if (html) html.insertBefore(head, html.firstChild);
  else document.appendChild(head);
  return head;
}

/**
 * @param {string} href
 * @param {string} base
 * @returns {string|null}
 */
function absolute(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isHttp(url) {
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * @param {string} href
 * @returns {string|null}
 */
function schemeOf(href) {
  const match = /^([a-z][a-z\d+.-]*:)/i.exec(href);
  return match ? match[1].toLowerCase() : null;
}

/**
 * @param {string|null} rel
 * @returns {string}
 */
function withNoopener(rel) {
  const parts = new Set(
    String(rel ?? '')
      .split(/\s+/)
      .filter(Boolean),
  );
  parts.add('noopener');
  return [...parts].join(' ');
}
