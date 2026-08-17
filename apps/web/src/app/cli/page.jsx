import { COMMANDS, GLOBAL_OPTIONS, VERSION } from '@profullstack/rssamplifier';

import { siteUrl } from '../../lib/db.js';
import Toolbar from '../Toolbar.jsx';

export const metadata = {
  title: 'Command line',
  description:
    'Install the rssamplifier CLI with one command. Find feeds by topic, search tens of thousands of independent blogs, and export OPML — from a terminal, a script or an agent.',
  alternates: { canonical: '/cli' },
};

// Same reason as /mcp: this page's whole job is printing the address people
// install from, and baking a build-time SITE_URL into it would be the one place
// that must never be wrong.
export const dynamic = 'force-dynamic';

/**
 * The CLI, documented for the person about to install it.
 *
 * The command table is generated from the same array the program dispatches on,
 * so a command that exists and is undocumented — or documented and gone — is
 * impossible. See apps/cli/src/index.js.
 */
export default function CliPage() {
  const site = siteUrl();
  const install = `curl -fsSL ${site}/install.sh | sh`;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd(site)) }}
      />

      <h1>Command line</h1>
      <p className="lede">
        The directory from a terminal. Find feeds by subject, search tens of thousands of
        independent blogs, export a subscription list, submit a site. No key, no account, no
        sign-up — it talks to the same public API everything else here does.
      </p>

      <h2>Install</h2>
      <pre className="code-block">
        <code>{install}</code>
      </pre>
      <p>
        That downloads one file to <code>~/.local/bin/rssamp</code> and marks it executable. It is a
        single Node script with no dependencies, so there is no package to update and no tree to
        audit — you can read the whole thing at <a href="/cli/rssamp">/cli/rssamp</a> before you run
        it, and the installer itself at <a href="/install.sh">/install.sh</a>.
      </p>
      <p>
        Node 22 or newer is the only requirement. Install somewhere else with{' '}
        <code>RSSAMP_BIN=/usr/local/bin</code>, and uninstall by deleting{' '}
        <code>rssamp</code> and <code>rssamplifier</code> from wherever you put them.
      </p>
      <p>
        Current version is <code>{VERSION}</code>. Re-running the installer upgrades in place.
      </p>

      <h2>Start here</h2>
      <p>
        The directory is organised by topic, and a topic is the fastest route from a subject to
        feeds worth reading. Three commands cover most of what anyone wants:
      </p>
      <pre className="code-block">
        <code>{`# what does this directory cover about homelabs?
rssamp topics homelab

# the feeds filed under one subject, strongest first
rssamp topic homelab

# take them somewhere else
rssamp opml --topic homelab > homelab.opml
rssamp urls --topic homelab | head`}</code>
      </pre>

      <h2>Commands</h2>
      <div className="tool-list">
        {COMMANDS.map((command) => (
          <div className="tool" key={command.name}>
            <h3>
              <code>rssamp {command.usage}</code>
            </h3>
            <p>{command.detail}</p>
            {command.options?.length ? (
              <p className="tool-args">{command.options.join(' · ')}</p>
            ) : null}
            {command.examples?.length ? (
              <pre className="code-block">
                <code>{command.examples.join('\n')}</code>
              </pre>
            ) : null}
          </div>
        ))}
      </div>

      <h2>Options</h2>
      <p>These work on every command that has anything to do with them:</p>
      <div className="tool-list">
        {GLOBAL_OPTIONS.map((option) => (
          <div className="tool" key={option.flag}>
            <h3>
              <code>{option.flag}</code>
            </h3>
            <p>{option.detail}</p>
          </div>
        ))}
      </div>

      <h2>For agents and scripts</h2>
      <p>
        Every command takes <code>--json</code> and writes to stdout, so the CLI composes the way
        anything else in a pipeline does. Exit codes are meant to be branched on: a submission where
        nothing was accepted exits non-zero, and so does a <code>urls</code> that matched no feeds.
        A search that legitimately found nothing exits zero — &ldquo;the directory does not cover
        this&rdquo; is an answer, not a failure.
      </p>
      <pre className="code-block">
        <code>{`rssamp search "agentic coding" --json | jq -r '.posts[].url'
rssamp topics rust --json | jq -r '.topics[] | "\\(.feedCount)\\t\\(.slug)"'
rssamp topic homelab --json | jq -r '.feeds[].feedUrl'`}</code>
      </pre>
      <p>
        An agent that can speak MCP should use <a href="/mcp">the MCP server</a> instead — it is the
        same data without a subprocess, and it describes its own arguments. The CLI is the better
        fit when the agent is already driving a shell, when the output needs to land in a file, or
        when a human is going to read it.
      </p>

      <h2>Feeding another reader</h2>
      <p>
        <code>urls</code> prints one feed URL per line and <code>opml</code> prints a subscription
        list, which between them are what every other feed tool accepts. Point them at a topic
        rather than the whole directory: fifty thousand feeds is not a subscription, it is a denial
        of service against your own reader.
      </p>
      <pre className="code-block">
        <code>{`rssamp urls --topic selfhosted > selfhosted.txt
rssamp opml --kind podcast --limit 500 > podcasts.opml`}</code>
      </pre>
      <p>
        Both are thin wrappers over <a href="/opml?topic=homelab">/opml?topic=</a>, so a tool that
        can subscribe to a URL does not need the CLI at all — hand it{' '}
        <code>{site}/opml?topic=homelab</code> and let it refetch as the topic grows.
      </p>

      <h2>Pointing it somewhere else</h2>
      <p>
        <code>--api</code> or <code>$RSSAMP_API</code> changes the deployment it talks to, which is
        how you run it against a local checkout:
      </p>
      <pre className="code-block">
        <code>{`RSSAMP_API=http://localhost:3000 rssamp list --limit 5`}</code>
      </pre>

      <Toolbar />
    </>
  );
}

/**
 * The CLI as a SoftwareApplication, so an agent reading this page can tell it
 * describes an installable thing rather than a documentation article.
 *
 * @param {string} site
 */
function jsonLd(site) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'rssamplifier CLI',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, macOS, Windows (WSL)',
    softwareVersion: VERSION,
    url: `${site}/cli`,
    downloadUrl: `${site}/cli/rssamp`,
    softwareRequirements: 'Node.js 22 or newer',
    license: 'https://opensource.org/licenses/MIT',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };
}
