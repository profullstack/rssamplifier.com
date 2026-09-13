import { notFound, redirect } from 'next/navigation';

import { loadAuthorProfile } from '../../../../lib/authorProfile.js';
import { callerOf, isOwner } from '../../../../lib/profileAuth.js';

export const dynamic = 'force-dynamic';

/** The sections the form offers a box for, in the order the file renders them. */
const SECTIONS = [
  ['about', 'About', 'A paragraph or two in your own words.'],
  ['accounts', 'Accounts', 'One per line: a URL, or [Label](https://url). The URL is the identity.'],
  ['topics', 'Topics', 'One per line, or comma-separated. The words you would use to find yourself.'],
  [
    'broadcast',
    'Broadcast',
    'Your show, as OpenBroadcast keys: - **Show**: ..., - **Seeking**: ..., - **Not**: ..., - **Book**: ..., - **Pays**: no. Two shows: a ### heading per show.',
  ],
  [
    'guest',
    'Guest',
    'That you will appear on other shows, as OpenGuest keys: - **Available**: yes, - **Expertise**: ..., - **Pitch**: ..., - **Rate**: free, - **Book**: ...',
  ],
  ['links', 'Links', 'One per line: [Label](https://url).'],
];

/**
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { slug } = await params;
  return { title: `Edit profile · ${slug}`, robots: { index: false } };
}

/**
 * The owner correcting their own OpenProfile.md.
 *
 * One field per part of the file, each holding the whole of that part as it
 * is served now, generated text included. Saving stores what is in the boxes
 * as the owner's word; a box left as generated stays generated, a box emptied
 * drops the section, and every box is Markdown exactly as the file will carry
 * it. There is no second form language to learn: what you type here is what
 * /authors/{slug}/openprofile.md will say.
 *
 * @param {{ params: Promise<{ slug: string }>, searchParams: Promise<{ saved?: string, claimed?: string, error?: string }> }} props
 */
export default async function EditProfilePage({ params, searchParams }) {
  const { slug: raw } = await params;
  const slug = raw.toLowerCase();
  const query = await searchParams;

  const loaded = await loadAuthorProfile(slug);
  if (!loaded) notFound();

  const caller = await callerOf(new Request('http://localhost/'));
  if (!caller.kind) redirect(`/login?next=${encodeURIComponent(`/authors/${slug}/edit`)}`);

  const page = `/authors/${encodeURIComponent(slug)}`;
  if (!isOwner(caller, loaded.profile)) {
    return (
      <>
        <p className="eyebrow">
          <a href="/authors">Authors</a> · <a href={page}>{loaded.person.name}</a>
        </p>
        <h1>Not yours to edit yet</h1>
        <p>
          {loaded.profile?.claimed_at
            ? 'This profile has been claimed by somebody else. If that is you under another account, sign in as that account.'
            : 'Claim the profile first. It is verified automatically when you are signed in with the address you published on your site, or when your site links back here.'}
        </p>
        {!loaded.profile?.claimed_at && (
          <form action={`/api/authors/${encodeURIComponent(slug)}/claim`} method="post" className="submit-actions">
            <button type="submit">Claim this profile</button>
          </form>
        )}
        {query.error && <p className="notice">{query.error}</p>}
      </>
    );
  }

  const doc = loaded.doc;
  const identityText = doc.identity.map((e) => `${e.key}: ${e.value}`).join('\n');
  const bodyOf = (name) => doc.sections.find((s) => s.name === name)?.body ?? '';

  return (
    <>
      <p className="eyebrow">
        <a href="/authors">Authors</a> · <a href={page}>{loaded.person.name}</a>
      </p>
      <h1>Your profile</h1>
      <p>
        What you save here is what <a href={loaded.url}>{loaded.url.replace(/^https?:\/\//, '')}</a>{' '}
        says, in the shape every directory that reads{' '}
        <a href="https://logicsrc.com/openprofile">OpenProfile.md</a> understands. Boxes hold what
        the file says now; change any of them, or empty one to drop that section. A key or a
        section the spec does not know is kept as written.
      </p>

      {query.claimed && <p className="notice">The profile is yours. Edit it below, or leave it as read.</p>}
      {query.saved && <p className="notice">Saved.</p>}
      {query.error && <p className="notice">{query.error}</p>}

      <form action={`/api/authors/${encodeURIComponent(slug)}/openprofile`} method="post" className="submit-box profile-edit">
        <label htmlFor="pe-name">Name</label>
        <input id="pe-name" name="name" type="text" defaultValue={doc.name ?? ''} maxLength={120} />

        <label htmlFor="pe-headline">Headline</label>
        <input id="pe-headline" name="headline" type="text" defaultValue={doc.headline ?? ''} maxLength={300} />

        <label htmlFor="pe-identity">Identity</label>
        <p className="hint">
          One <code>Key: value</code> per line. Kind, Handle, Web, Email, Location, Pronouns,
          Timezone, Languages, Avatar, DID, Pay, Resume; any other key is kept too. Email is only
          published if you put it here.
        </p>
        <textarea id="pe-identity" name="identity" rows={6} defaultValue={identityText} />

        {SECTIONS.map(([name, title, hint]) => (
          <div key={name}>
            <label htmlFor={`pe-${name}`}>{title}</label>
            <p className="hint">{hint}</p>
            <textarea id={`pe-${name}`} name={`section_${name}`} rows={6} defaultValue={bodyOf(name)} />
          </div>
        ))}

        <label>
          <input type="checkbox" name="public" defaultChecked={loaded.profile?.public ?? true} /> Serve the
          file publicly (off hides the profile file; your page stays)
        </label>

        <div className="submit-actions">
          <button type="submit">Save</button>{' '}
          <a href={loaded.url}>View the file</a>
        </div>
      </form>

      <p className="hint">
        The same edit works from anywhere: <code>PUT {`/api/authors/${slug}/openprofile`}</code> with
        the whole file as <code>text/markdown</code> or a JSON patch, with one of your API keys or an
        OpenAccess grant for <code>openprofile:edit</code>; <code>rssamp profile edit {slug}</code>{' '}
        from the CLI; <code>update_openprofile</code> over MCP.
      </p>
    </>
  );
}
