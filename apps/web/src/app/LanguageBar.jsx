import { languageName } from '@rssamplifier/translate';

/**
 * "Original · en | de | es | …" for one post.
 *
 * The languages are the ones the directory is actually full of, not a fixed
 * list: a reader here runs into German Proxmox threads and Spanish link blogs
 * because that is what the small web is made of, so those are the languages
 * worth one click.
 *
 * Each choice is its own form posting to /api/translate, like every other
 * control on the site — no client bundle, works with JavaScript off, and the
 * 303 back to the post keeps the browser's history sane. It is a POST rather
 * than a link because it does two things a GET should not: it can spend money
 * on a first translation, and it remembers the choice on the account.
 *
 * Signed out, the same buttons send the reader to sign in and back again. The
 * feature costs real money per post translated, so it is offered to accounts
 * only — but that is a reason to ask someone to sign in, not a reason to hide
 * the fact that the post can be read in their language.
 *
 * @param {{
 *   slug: string,
 *   guid: string,
 *   languages: string[],
 *   active: string|null,
 *   signedIn: boolean,
 * }} props
 */
export default function LanguageBar({ slug, guid, languages, active, signedIn }) {
  if (languages.length === 0) return null;

  const back = `/${slug}/read?p=${encodeURIComponent(guid)}`;

  return (
    <div className="language-bar">
      <span className="label">Read in</span>

      <Choice slug={slug} guid={guid} lang="" active={active === null} signedIn={signedIn} back={back}>
        Original
      </Choice>

      {languages.map((code) => (
        <Choice
          key={code}
          slug={slug}
          guid={guid}
          lang={code}
          active={active === code}
          signedIn={signedIn}
          back={back}
          title={languageName(code)}
        >
          {code}
        </Choice>
      ))}
    </div>
  );
}

/**
 * One language, as its own form.
 *
 * @param {{
 *   slug: string,
 *   guid: string,
 *   lang: string,
 *   active: boolean,
 *   signedIn: boolean,
 *   back: string,
 *   title?: string,
 *   children: React.ReactNode,
 * }} props
 */
function Choice({ slug, guid, lang, active, signedIn, back, title, children }) {
  const label = title ? `Read this post in ${title}` : 'Read this post as published';

  if (!signedIn) {
    // Sign-in first, then straight back to the post with the language applied —
    // the same shape as every other signed-out action here.
    const next = lang ? `${back}&lang=${encodeURIComponent(lang)}` : back;
    return (
      <a
        className="lang"
        href={`/login?next=${encodeURIComponent(next)}`}
        title={`${label} — sign in`}
      >
        {children}
      </a>
    );
  }

  return (
    <form method="post" action="/api/translate" className="inline-form">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="guid" value={guid} />
      <input type="hidden" name="lang" value={lang} />
      <button
        type="submit"
        className={`lang${active ? ' on' : ''}`}
        title={label}
        aria-pressed={active}
      >
        {children}
      </button>
    </form>
  );
}
