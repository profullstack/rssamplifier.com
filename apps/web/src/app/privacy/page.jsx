export const metadata = {
  title: 'Privacy',
  description:
    'What RSS Amplifier collects, why, how long it is kept, and how to have it deleted.',
};

/**
 * The privacy policy.
 *
 * Written from what the code actually does rather than from a template, so it
 * has to be re-read whenever the data the site handles changes: the session
 * cookie in packages/auth, the notification emails on /submit and /discover,
 * and the analytics and ad scripts in the root layout are the four things it
 * describes.
 *
 * NOTE: privacy@rssamplifier.com below needs an alias on Forward Email, which
 * carries this domain's mail. A published rights contact that bounces is worse
 * than no policy at all, so that alias is a prerequisite for this page, not a
 * follow-up to it.
 */
export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy</h1>
      <p className="lede">
        This is a directory of public feeds. Reading it needs no account and collects no personal
        data beyond what is described here.
      </p>

      <h2>What we collect</h2>

      <h3>If you only browse</h3>
      <p>
        Nothing you give us. Our analytics script records the page you viewed, the referring page,
        and a coarse device and country derived from your request, and it stores a random visitor
        identifier in your browser&rsquo;s local storage so repeat visits can be counted as one
        visitor rather than many. That identifier is not linked to a name or an email address, and
        clearing site data removes it.
      </p>
      <p>
        Advertising is served through the same first-party endpoint. Ad impressions are counted on
        the server from the request itself; no advertiser receives a profile of you and no
        cross-site tracking cookie is set.
      </p>

      <h3>If you submit a feed</h3>
      <p>
        The URL, list of URLs or OPML file you submit, and the email address if you chose to give
        one so we could tell you when the import finished. Submitted feeds are public: that is the
        point of the directory. The email address is used for that one notification.
      </p>

      <h3>If you create an account</h3>
      <p>
        Your email address, and a passkey&rsquo;s public credential if you register one. Signing in
        is by emailed link or by passkey; there are no passwords, so there is nothing to breach on
        that front. Your follows, favorites, reactions and comments are stored against your account.
        Comments you post are public.
      </p>
      <p>
        Signing in sets one cookie holding your session. It is marked{' '}
        <code>HttpOnly</code>, <code>Secure</code> and <code>SameSite=Lax</code>, it is not readable
        by scripts, and it is strictly necessary to keep you signed in. Signing out clears it.
      </p>

      <h2>Who we share it with</h2>
      <p>
        Nobody who is not needed to run the site. Email is delivered by a transactional email
        provider, the site and its database are hosted by our infrastructure providers, and
        analytics and ads are served by <a href="https://crawlproof.com">Crawlproof</a>, which is
        operated by the same company. We do not sell personal data and we do not share it with
        advertisers or data brokers.
      </p>
      <p>
        Some pages summarise or translate a post on request. Where that is done by a third-party
        model provider, the text of the public post is what is sent; your identity is not.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Directory content — feeds, posts and public comments — is kept for as long as the entry is
        listed. Account data is kept until you delete the account. Analytics records are aggregated
        and retained in aggregate form. Notification email addresses given on the submit and
        discover forms are used for that notification and are not added to any mailing list.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of what we hold about you, ask for it to be corrected, or ask for it
        to be deleted, and we will act on it. If you are in the UK or the EU, the UK GDPR and GDPR
        give you those rights explicitly, along with the right to complain to your data protection
        authority. Our lawful basis is legitimate interest for running and measuring the directory,
        and consent where you have given us an email address.
      </p>
      <p>
        To remove a feed you submitted, to delete an account, or to make any of the requests above,
        email <a href="mailto:privacy@rssamplifier.com">privacy@rssamplifier.com</a>.
      </p>

      <h2>Who we are</h2>
      <p>
        RSS Amplifier is operated by <a href="https://profullstack.com">Profullstack, Inc.</a>
      </p>
    </>
  );
}
