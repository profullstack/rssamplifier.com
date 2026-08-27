/**
 * Shared logic for the sign-in form, which appears on both /login and /signup.
 *
 * There is one mechanism behind those two pages — no password, so proving you
 * can read an address is the whole of it, and an address nobody has used before
 * becomes an account. Only the wording differs. These are the two bits of that
 * which are not markup, kept here so the pages cannot drift apart.
 */

/** Pages that host the sign-in form. */
const FORM_PAGES = new Set(['/login', '/signup']);

/** Where an unrecognised or absent value lands. */
const DEFAULT_PAGE = '/login';

/**
 * Where to send a reader back to after asking for a sign-in link.
 *
 * The difference matters to the person filling the form in: somebody who
 * clicked "Create an account" and then landed on a page headed "Sign in" has
 * been given a reason to wonder whether it worked. So the form declares which
 * page it was on, and this decides whether to believe it.
 *
 * An allowlist rather than an "is it a local path" check. The value is
 * reflected straight into a Location header, and the set of pages hosting this
 * form is two — an arbitrary path is never the right answer, so there is no
 * reason to accept one and then have to reason about whether the parsing is
 * airtight.
 *
 * @param {unknown} from the form's declared page
 * @returns {string} a path from FORM_PAGES, never anything else
 */
export function magicReturnPath(from) {
  // Strings only, deliberately not String(from). This reads a FormData value,
  // which is a string or a File, and anything with a co-operative toString —
  // a one-element array, an object — would otherwise coerce its way onto the
  // allowlist. A value that is not already text is not a path.
  if (typeof from !== 'string') return DEFAULT_PAGE;

  const value = from.trim();
  return FORM_PAGES.has(value) ? value : DEFAULT_PAGE;
}

/**
 * How long to wait, in words a person can act on.
 *
 * Seconds are what the throttle deals in and the wrong unit to show: "retry
 * after 3600" reads as a number to be worked around, "in about an hour" reads
 * as an answer.
 *
 * @param {unknown} seconds
 * @returns {string}
 */
function waitFor(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return 'in a moment';
  if (n < 90) return `in ${Math.max(1, Math.round(n))} seconds`;
  if (n < 5400) return `in about ${Math.round(n / 60)} minutes`;
  if (n < 86_400) return `in about ${Math.round(n / 3600)} hours`;
  return 'tomorrow';
}

/**
 * Turn an error code from the sign-in routes into something worth reading.
 *
 * @param {unknown} code
 * @param {unknown} [retry] seconds to wait, when the code carries one
 * @returns {string}
 */
export function explainSignInError(code, retry) {
  if (code === 'too-many') {
    // Deliberately says what to do rather than what happened. Whoever this is
    // aimed at will not read it, and the one person who sees it by accident is
    // a reader who pressed the button too often.
    return `Too many sign-in attempts from your connection. Try again ${waitFor(retry)}.`;
  }
  if (code === 'invalid-or-expired') {
    return 'That link has expired or was already used. Ask for a new one.';
  }
  if (code === 'invalid-email') return 'That does not look like an email address.';
  if (code === 'email-not-configured') {
    return 'Email is not configured on this deployment, so links cannot be sent. Use a passkey.';
  }
  if (code === 'missing-token') return 'That link was incomplete. Ask for a new one.';
  return 'Something went wrong. Try again.';
}
