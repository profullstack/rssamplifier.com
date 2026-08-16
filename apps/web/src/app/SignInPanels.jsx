import { PasskeySignIn } from './Passkey.jsx';

/**
 * The two ways into an account, as a pair of panels.
 *
 * /login and /signup are the same mechanism — there is no password, so proving
 * you can read an address is the whole of it, and an address nobody has used
 * before simply becomes an account. What differs between the two pages is who
 * is reading and what they need told, so the markup lives here once and the
 * wording is passed in.
 *
 * @param {{
 *   from: string,
 *   next?: string,
 *   emailEyebrow: string,
 *   emailButton: string,
 *   passkeyEyebrow: string,
 *   passkeyHint: React.ReactNode,
 * }} props
 */
export default function SignInPanels({
  from,
  next = '/account',
  emailEyebrow,
  emailButton,
  passkeyEyebrow,
  passkeyHint,
}) {
  return (
    <>
      <form className="submit-box" action="/api/auth/magic" method="post">
        <p className="eyebrow">{emailEyebrow}</p>
        {/* Which page the form was on, so the redirect afterwards comes back
            here rather than always to /login. Validated against a fixed list
            on the way out — see lib/returnTo.js. */}
        <input type="hidden" name="from" value={from} />
        <input
          type="email"
          name="email"
          placeholder="you@example.com"
          aria-label="Your email address"
          autoComplete="email"
          required
        />
        <div className="submit-actions">
          <button type="submit">{emailButton}</button>
        </div>
      </form>

      <div className="submit-box">
        <p className="eyebrow">{passkeyEyebrow}</p>
        <p className="hint">{passkeyHint}</p>
        <div className="submit-actions">
          <PasskeySignIn next={next} />
        </div>
      </div>
    </>
  );
}
