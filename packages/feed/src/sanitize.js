/**
 * Sanitize article HTML down to what is safe to render on our own page.
 *
 * Two untrusted sources feed this, and the second one surprises people: a
 * blog's own `content:encoded`, which is a stranger's markup, and the
 * translator's output, which is a language model's. A model asked to translate
 * HTML returns HTML, and "the model wouldn't do that" is not a security
 * boundary — a prompt-injecting post could ask it for a script tag and the
 * model has no reason to refuse. Both go through here.
 *
 * Allowlist, not blocklist. Everything not named below is dropped, so a tag or
 * attribute nobody thought about fails closed. This is deliberately stricter
 * than a general-purpose sanitizer: the reader shows prose, and prose does not
 * need forms, embeds, styles or event handlers.
 */

/** Elements kept, with their contents. */
const ALLOWED = new Set([
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'blockquote', 'q', 'cite',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'pre', 'code', 'kbd', 'samp', 'var',
  'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'span', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'time', 'abbr',
]);

/**
 * Elements dropped along with everything inside them.
 *
 * The rest of the sanitizer drops the tag but keeps the text — right for a
 * `<font>`, catastrophic for a `<script>`, whose "text" is the program.
 */
const STRIP_WITH_CONTENT = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'template', 'svg', 'math', 'form', 'input', 'button', 'select', 'textarea', 'canvas', 'audio', 'video', 'source', 'track', 'link', 'meta', 'base', 'title', 'head']);

/** Attributes kept, per element. `*` applies to every allowed element. */
const ALLOWED_ATTRS = {
  '*': new Set(['title', 'lang', 'dir']),
  a: new Set(['href', 'title', 'lang', 'dir']),
  img: new Set(['src', 'alt', 'title', 'width', 'height', 'lang', 'dir']),
  time: new Set(['datetime', 'title', 'lang', 'dir']),
  abbr: new Set(['title', 'lang', 'dir']),
  td: new Set(['colspan', 'rowspan', 'title', 'lang', 'dir']),
  th: new Set(['colspan', 'rowspan', 'scope', 'title', 'lang', 'dir']),
  col: new Set(['span', 'title', 'lang', 'dir']),
  colgroup: new Set(['span', 'title', 'lang', 'dir']),
  ol: new Set(['start', 'reversed', 'type', 'title', 'lang', 'dir']),
};

/**
 * URL schemes a link or image may use.
 *
 * `javascript:` is the obvious one to keep out, but `data:` matters as much —
 * a data URL can carry an HTML document, and a link to one runs it on our
 * origin. Protocol-relative and relative URLs are resolved against the post's
 * own site before they get here, so anything still relative is dropped rather
 * than pointed at rssamplifier.com.
 */
const SAFE_SCHEME = /^(https?:|mailto:)/i;

/**
 * Is this URL safe to put in an href or src?
 *
 * The value is unescaped first: `java&#115;cript:` and `java\tscript:` are both
 * `javascript:` to a browser, and a check that only looks at the literal text
 * lets them through.
 *
 * @param {string} value
 * @returns {boolean}
 */
function safeUrl(value) {
  const decoded = String(value ?? '')
    .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([\da-f]+);?/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
    // Control characters and whitespace inside a scheme are ignored by
    // browsers — "java\tscript:" runs — so they come out before the scheme is
    // read rather than being trusted to survive as literal text.
    .replace(/[\u0000-\u0020]/g, '')
    .trim();

  return SAFE_SCHEME.test(decoded);
}

/**
 * @param {string} name
 * @param {string} tag
 * @returns {boolean}
 */
function attrAllowed(tag, name) {
  // Nothing beginning with `on` is ever allowed, whatever the per-tag list
  // says: onclick, onerror, onload and the several hundred others are one
  // family and enumerating them is how a sanitizer gets it wrong.
  if (/^on/i.test(name)) return false;
  const allowed = ALLOWED_ATTRS[tag] ?? ALLOWED_ATTRS['*'];
  return allowed.has(name.toLowerCase());
}

/**
 * Strip HTML to a safe subset.
 *
 * Text is preserved for tags that are merely unknown — a `<font>` becomes its
 * own contents rather than disappearing — because dropping the text of a
 * presentational tag would silently delete sentences from an article.
 *
 * @param {string} html
 * @param {{ maxLength?: number }} [opts]
 * @returns {string}
 */
export function sanitizeHtml(html, opts = {}) {
  const { maxLength = 400_000 } = opts;

  let input = String(html ?? '');
  if (!input) return '';
  if (input.length > maxLength) input = input.slice(0, maxLength);

  // Comments go first: `<!-- <script> -->` is a comment to the parser below
  // but conditional comments are not, and the contents are never displayed.
  input = input.replace(/<!--[\s\S]*?(?:-->|$)/g, '');

  for (const tag of STRIP_WITH_CONTENT) {
    input = input.replace(
      new RegExp(`<${tag}\\b[\\s\\S]*?(?:</${tag}\\s*>|$)`, 'gi'),
      ' ',
    );
    // A closing tag with no opener would otherwise survive as text.
    input = input.replace(new RegExp(`</${tag}\\s*>`, 'gi'), '');
  }

  /** @type {string[]} */
  const open = [];

  const out = input.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>?/g, (match, rawTag, rawAttrs) => {
    const tag = String(rawTag).toLowerCase();
    const closing = match.startsWith('</');

    if (!ALLOWED.has(tag)) return ' ';

    if (closing) {
      // Only close what was opened, so a stray `</div>` cannot break out of
      // the container this html is rendered into.
      const at = open.lastIndexOf(tag);
      if (at === -1) return '';
      open.splice(at, 1);
      return `</${tag}>`;
    }

    const attrs = [];
    const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let found;
    while ((found = pattern.exec(String(rawAttrs ?? ''))) !== null) {
      const name = found[1].toLowerCase();
      const value = found[2] ?? found[3] ?? found[4] ?? '';
      if (!attrAllowed(tag, name)) continue;
      if ((name === 'href' || name === 'src') && !safeUrl(value)) continue;
      attrs.push(`${name}="${escapeAttr(value)}"`);
    }

    const selfClosing = /\/\s*$/.test(String(rawAttrs ?? '')) || tag === 'br' || tag === 'hr' || tag === 'img' || tag === 'col';
    if (!selfClosing) open.push(tag);

    // Every link leaves our page for a stranger's, so every link is marked as
    // such — and noopener is not optional on a target=_blank we generate.
    const extra =
      tag === 'a'
        ? ' target="_blank" rel="noopener noreferrer ugc"'
        : tag === 'img'
          ? ' loading="lazy"'
          : '';

    return `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}${extra}${selfClosing ? ' /' : ''}>`;
  });

  // Anything left open is closed here rather than by the browser, which would
  // otherwise absorb the rest of our page into the article's last unclosed
  // element.
  const closers = open.reverse().map((tag) => `</${tag}>`).join('');
  return `${out}${closers}`.replace(/\s+\n/g, '\n').trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Roughly how much text an HTML fragment carries.
 *
 * Used to decide whether an article is worth sending to a translator, and to
 * bound what is sent. Markup is not free to translate but it is not what the
 * reader is paying for either.
 *
 * @param {string} html
 * @returns {number}
 */
export function textLength(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}
