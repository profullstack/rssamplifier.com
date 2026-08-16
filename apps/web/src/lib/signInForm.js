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
 * Turn an error code from the sign-in routes into something worth reading.
 *
 * @param {unknown} code
 * @returns {string}
 */
export function explainSignInError(code) {
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
