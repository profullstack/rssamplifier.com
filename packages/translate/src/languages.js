/**
 * Language codes, and deciding which ones the reader is offered.
 *
 * Feed metadata is not tidy: the same language arrives as "de", "de-DE",
 * "de_DE", "DE" and " de " depending on who generated the feed. Everything here
 * folds those onto one bare ISO-639-1 code, because that code is half of the
 * primary key on a cached translation — two spellings would mean translating
 * the same post twice and paying for it twice.
 */

/** English is always offered, whatever the directory happens to hold. */
export const BASE_LANGUAGE = 'en';

/**
 * How many languages the bar shows at most.
 *
 * A row of links is a navigation aid, not a catalogue: past a handful it stops
 * being scannable and starts being a menu nobody reads.
 */
export const MAX_OFFERED = 8;

/**
 * Fold any spelling of a language tag onto its bare ISO-639-1 code.
 *
 * Returns null rather than a guess for anything that is not two letters —
 * three-letter codes, "x-default", empty strings — so a caller can treat "we do
 * not know this post's language" as a real, distinct state.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeLang(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return null;

  const [primary] = raw.split(/[-_]/);
  return /^[a-z]{2}$/.test(primary) ? primary : null;
}

/**
 * The name of a language.
 *
 * Named in that language by default, because the language bar exists to be
 * recognised by someone who cannot yet read the page: a German reader looking
 * for German wants "Deutsch", not "German". Pass `locale` where the name sits
 * inside a sentence in a known language instead — "Translated from Deutsch"
 * is neither one language nor the other.
 *
 * @param {string} code
 * @param {string} [locale] language to name it in; defaults to itself
 * @returns {string}
 */
export function languageName(code, locale) {
  try {
    const name = new Intl.DisplayNames([locale ?? code], { type: 'language' }).of(code);
    // Intl hands back the code itself for anything it has no name for, which
    // would put a bare lowercase "zz" where a language name belongs. Uppercased
    // it at least reads as a code on purpose rather than as a broken label.
    return name && name !== code ? name : code.toUpperCase();
  } catch {
    // A malformed tag makes Intl throw outright.
    return code.toUpperCase();
  }
}

/**
 * Which languages to offer, given what the directory actually holds.
 *
 * Ordered by how much of the catalogue is in each, because that is the honest
 * answer to "what will a reader here run into" — a language nobody publishes in
 * is a link nobody clicks.
 *
 * @param {Array<{ language: string, feeds: number }>} counts from q.languageCounts
 * @param {{ max?: number, always?: string[] }} [opts] `always` is pinned to the
 *   front regardless of how little of the catalogue uses it
 * @returns {string[]} bare ISO-639-1 codes
 */
export function offeredLanguages(counts, opts = {}) {
  const max = opts.max ?? MAX_OFFERED;
  const always = (opts.always ?? [BASE_LANGUAGE])
    .map(normalizeLang)
    .filter((code) => code !== null);

  /** @type {Map<string, number>} */
  const totals = new Map();
  for (const row of counts) {
    const code = normalizeLang(row.language);
    if (!code) continue;
    totals.set(code, (totals.get(code) ?? 0) + Number(row.feeds ?? 0));
  }

  const ranked = [...totals.entries()]
    // Ties sort alphabetically rather than by insertion, so the bar does not
    // reorder itself between deploys for no visible reason.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code]) => code);

  const ordered = [...always, ...ranked.filter((code) => !always.includes(code))];
  return ordered.slice(0, Math.max(max, always.length));
}
