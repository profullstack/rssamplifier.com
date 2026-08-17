export const metadata = {
  title: 'Contact',
  description:
    'How to reach the people who run RSS Amplifier: general questions, corrections to a listing, privacy requests and security reports.',
};

/**
 * The contact page.
 *
 * There was no way to reach a person from anywhere on the site. The footer
 * offered About, Privacy and the GitHub repository, which between them cover
 * "what is this", "what do you keep" and "here is a bug" — but not "this entry
 * about my blog is wrong", which is the one a stranger whose feed we crawl is
 * most likely to have.
 *
 * Every route below is a destination that already exists, so the page routes
 * rather than collects: no form, because a form on a site with no accounts is
 * one more thing to spam.
 *
 * NOTE: hello@ and security@ need aliases on Forward Email, which carries this
 * domain's mail, exactly as privacy@ does — see the note on the privacy page.
 * A published address that bounces is worse than no page.
 */
export default function ContactPage() {
  return (
    <>
      <h1>Contact</h1>
      <p className="lede">
        RSS Amplifier is built and run by{' '}
        <a href="https://profullstack.com">Profullstack, Inc.</a> There is no support queue and no
        account system; the addresses below reach people.
      </p>

      <h2>Add or correct a listing</h2>
      <p>
        To add a feed, use <a href="/submit">the submit page</a> — it takes a URL, a list of URLs or
        an OPML file, and needs no account.
      </p>
      <p>
        If an entry about your site is wrong, or you would like it removed, email{' '}
        <a href="mailto:hello@rssamplifier.com">hello@rssamplifier.com</a> with the address of the
        page. We only index public feeds, and we remove on request without asking why.
      </p>

      <h2>Bugs and feature requests</h2>
      <p>
        The site is open source. Please open an issue at{' '}
        <a href="https://github.com/profullstack/rssamplifier.com/issues" rel="noopener">
          github.com/profullstack/rssamplifier.com
        </a>{' '}
        — that way the discussion stays with the code.
      </p>

      <h2>Privacy</h2>
      <p>
        For access, correction or deletion requests, or any question about{' '}
        <a href="/privacy">the privacy policy</a>, email{' '}
        <a href="mailto:privacy@rssamplifier.com">privacy@rssamplifier.com</a>.
      </p>

      <h2>Security</h2>
      <p>
        To report a vulnerability, email{' '}
        <a href="mailto:security@rssamplifier.com">security@rssamplifier.com</a>. Machine-readable
        details are at <a href="/.well-known/security.txt">/.well-known/security.txt</a>. Please
        give us a chance to fix it before publishing.
      </p>

      <h2>Automated use</h2>
      <p>
        You do not need to ask. Crawling and reuse are welcome, and{' '}
        <a href="/llms.txt">llms.txt</a>, <a href="/skill.md">skill.md</a>, the{' '}
        <a href="/api/feeds">JSON API</a> and the <a href="/mcp">MCP server</a> are all public and
        need no key.
      </p>
    </>
  );
}
