import { notFound } from 'next/navigation';
import { q, reactions, translations } from '@rssamplifier/db';
import { sanitizeHtml } from '@rssamplifier/feed';
import { ensureTranslation, languageName, normalizeLang } from '@rssamplifier/translate';

import { db } from '../../../lib/db.js';
import { currentUser } from '../../../lib/auth.js';
import { popularLanguages } from '../../../lib/languages.js';
import { isEpisode, isWatchable, playableMedia } from '../../../lib/media.js';
import { readerView } from '../../../lib/reader.js';
import { AD_MREC } from '../../../lib/ads.js';
import Ad from '../../Ad.jsx';
import Comments from '../../Comments.jsx';
import EpisodePlayer from '../../EpisodePlayer.jsx';
import LanguageBar from '../../LanguageBar.jsx';
import PostActions from '../../PostActions.jsx';
import ReaderToolbar from '../../ReaderToolbar.jsx';

export const dynamic = 'force-dynamic';

/**
 * @param {{ params: Promise<{ slug: string }> }} props
 */
export async function generateMetadata({ params }) {
  const { slug } = await params;
  const feed = await q.feedBySlug(db(), slug);
  return {
    title: feed ? `Reading · ${feed.title}` : 'Not found',
    // The reader is a view of someone else's page; it should never compete with
    // the original in search results.
    robots: { index: false, follow: true },
  };
}

/**
 * Read one post without leaving the directory.
 *
 * Kagi's Small Web keeps its bar on screen while you read by framing the page,
 * and that is what makes browsing feel like one place rather than a list of
 * outbound links. This does the same: the post is framed, the roaming toolbar
 * stays put, and moving through a blog's archive never costs a round trip
 * through an index.
 *
 * Not every site permits it — plenty send X-Frame-Options or a frame-ancestors
 * policy — and a browser gives the embedder no way to detect that from the
 * outside. So the policy is checked server-side first and a refusal renders an
 * honest card rather than a blank rectangle.
 *
 * A lot of the small web is not written in English, and a post nobody in the
 * room can read is a dead end no matter how well it is framed. Asking for a
 * language translates the whole post — title, summary and body — and the
 * translated article is rendered here in place of the frame.
 *
 * That last part is a reversal, and worth saying why. The frame shows the
 * publisher's own page, served from their server, and nothing we do can
 * translate it; a reader who asked for Swedish and got a Swedish headline over
 * an English page has been shown that they cannot read this, not helped to.
 * The post's own text is something we already hold, so when a translation
 * exists the reader gets that instead, and the original is one click away in
 * the toolbar — where it now matters more, not less.
 *
 * @param {{
 *   params: Promise<{ slug: string }>,
 *   searchParams: Promise<{ p?: string, lang?: string }>,
 * }} props
 */
export default async function ReaderPage({ params, searchParams }) {
  const { slug } = await params;
  const { p: guid, lang } = await searchParams;

  const client = db();
  const feed = await q.feedBySlug(client, slug);
  if (!feed) notFound();

  const feedId = String(feed.id);

  // The post list doubles as the reader's running order, so newer/older are
  // just neighbours in the same query the blog page already makes.
  const posts = await q.itemsForFeed(client, feedId, 200);
  const index = guid ? posts.findIndex((item) => String(item.guid) === guid) : 0;

  // That window is a running order, not the archive: a fifth of all the posts
  // we hold sit outside their own feed's newest 200. Search reaches them, so
  // the reader has to as well — fall back to fetching the one post by guid and
  // simply do without neighbours, rather than claiming it does not exist.
  const inOrder = index >= 0 && posts[index] !== undefined;
  const post = inOrder ? posts[index] : guid ? await q.itemByGuid(client, feedId, guid) : null;

  if (!post) notFound();

  const postUrl = post.url ? String(post.url) : null;

  const audio = post.audio_url ? String(post.audio_url) : null;
  const mediaType = post.audio_type ? String(post.audio_type) : null;

  // A video post is not a page that failed to frame.
  //
  // YouTube's watch page refuses framing, like most video hosts, so a video
  // arrived here as "this site does not allow itself to be embedded" over a
  // link out — while the embed that does work sat docked in the corner at a
  // third of the width. The enclosure says what the post is, and when it says
  // video the video is the post: it plays where the article would be, and the
  // description goes under it, which is where a description goes.
  const watchable = isWatchable(post);

  // What to hand the player, which is not always the enclosure: a PeerTube post
  // plays through its embed, because the file its feed points at is a download
  // endpoint that stops resolving when the instance re-encodes.
  const media = playableMedia(post);

  // Reactions hang off the item id, which never leaves the server: the page and
  // the API both address a post as (slug, guid).
  const itemId = String(post.id);

  // Asked only when the answer can change anything. Framing a video host is not
  // on the table, and this is a request to somebody else's server on the way to
  // rendering every video page.
  //
  // When the answer is "you may not frame this", the same response is read for
  // the article rather than thrown away — see lib/reader.js. That is the whole
  // point: a refusal used to end the reader's job, and now it only changes how
  // the post is rendered.
  const verdict =
    postUrl && !watchable
      ? await readerView({ itemId, url: postUrl })
      : { frameable: false, reason: watchable ? 'video-post' : 'no-url', article: null };

  const nav = await q.neighbours(client, String(feed.created_at));
  const user = await currentUser();
  const userId = user ? String(user.id) : null;

  const [score, mine, thread, languages] = await Promise.all([
    reactions.scoreFor(client, itemId),
    userId ? reactions.reactionFor(client, userId, itemId) : { liked: false, vote: 0 },
    reactions.commentsFor(client, itemId),
    popularLanguages(),
  ]);

  // The URL wins over the stored preference, so a link someone was sent lands
  // in the language it names; with nothing in the URL the account's own choice
  // carries over from the last post they read.
  const asked =
    normalizeLang(lang) ??
    (userId ? normalizeLang(await translations.readingLanguage(client, userId)) : null);

  // Any language the URL can spell, not only the eight the bar offers. The bar
  // is a shortlist of what the directory is mostly written in; a link someone
  // was sent — or a reader whose language is not in the top eight — asked for
  // something real either way, and refusing it silently is how "?lang=sv did
  // nothing" happens.
  const wanted = asked;

  // Anonymous readers get translations somebody else already paid for: the row
  // is written, serving it costs nothing, and the alternative is showing a
  // reader English on a page whose translation is sitting in the database.
  // Paying for a *new* one still needs an account — ensureTranslation stops at
  // the cache without a userId. See /api/translate.
  const source = await translations.itemText(client, itemId);

  // The body to translate, which is now the extracted article when the feed
  // itself carried only a summary. Before this, asking for a language on a
  // summary-only feed translated a headline and left the reader on an English
  // card — the translator had nothing else to work with. It does now.
  const translatable = source?.content_html
    ? String(source.content_html)
    : (verdict.article?.html ?? null);

  const attempt = wanted
    ? await ensureTranslation(client, {
        itemId,
        title: String(post.title),
        summary: post.summary === null ? null : String(post.summary),
        contentHtml: translatable,
        targetLang: wanted,
        sourceLang: feed.language === null ? null : String(feed.language),
        userId,
      })
    : { translation: null, limited: false };

  const translated = attempt.translation;

  const title = translated ? translated.title : String(post.title);
  const summary = translated ? translated.summary : (post.summary ?? null);
  const sourceLang = normalizeLang(translated?.sourceLang ?? feed.language);

  // The body to render, already sanitized. Translated bodies are sanitized on
  // the way out of the translator as well; the original is sanitized here
  // because until now nothing rendered it and it has never been through a
  // sanitizer at all.
  const article = translated?.contentHtml
    ? translated.contentHtml
    : source?.content_html
      ? sanitizeHtml(String(source.content_html))
      : // Sanitized before it was stored, so it does not go round again.
        (verdict.article?.html ?? null);

  // Framing is what the reader does with a post it cannot show itself. A
  // translated article is one it can, so the frame gives way to it.
  const readable = Boolean(translated?.contentHtml);

  // Whether the media is the post or a file attached to one. Judged on what the
  // feed shipped rather than on what is being rendered, so the answer does not
  // change when a reader asks for a translation.
  const episode = isEpisode(post, source?.content_html ?? null);

  // The article we read off a page that refused to be framed — used only when
  // there is no translation to show in its place, since a translated body is
  // the same article in a language the reader asked for.
  const extracted = readable || watchable ? null : verdict.article;

  // Whether a frame is on screen, which the toolbar needs to know: only a
  // framed post can wander off the post it started on, and only then does
  // "Open ↗" have to follow rather than point at where the reader began.
  const framed = !watchable && !readable && verdict.frameable && Boolean(postUrl);

  // An audio post is not a page that failed to frame either.
  //
  // The video branch above already makes this argument; it just never got made
  // about audio, because audio had the docked player and looked handled. It was
  // not: a track on a Funkwhale instance sends X-Frame-Options, and its page is
  // a JavaScript app, so extraction comes back with nothing to render. Both
  // escapes closed, the post fell through to the last branch — a notice saying
  // the site refuses to be embedded, over a button sending the reader away —
  // while the mp3 sat in a player docked in the corner, ready to play. The
  // reader had the post the whole time and told the reader it did not.
  //
  // Narrower than `watchable` on purpose. A page that frames still frames: a
  // podcast's own episode page is worth showing, and the docked player keeps
  // the episode going behind it. This is only the branch where there is nothing
  // to show and something to play.
  const listenable = !watchable && !readable && !framed && !extracted && Boolean(media.src);

  return (
    <div className="reader">
      <div className="reader-head">
        <p className="eyebrow">
          <a href={`/${slug}`}>{String(feed.title)}</a>
          {post.published_at ? ` · ${formatDate(post.published_at)}` : ''}
        </p>
        <h1>{title}</h1>

        <LanguageBar
          slug={slug}
          guid={String(post.guid)}
          languages={languages}
          active={wanted}
          signedIn={Boolean(userId)}
        />

        {translated && (
          <p className="translated-note">
            Translated {sourceLang ? `from ${languageName(sourceLang, 'en')} ` : ''}by machine. The
            original is a click away in the toolbar.
          </p>
        )}

        {/*
         * Worth saying out loud rather than silently showing the original: this
         * is the one failure that fixes itself, and a reader who is told the
         * limit resets will come back instead of concluding the feature is
         * broken. Posts somebody has already had translated stay readable
         * throughout — the limit is on paying for new ones, not on reading.
         */}
        {attempt.limited && (
          <p className="translated-note">
            Translation limit reached for today — showing the original. Posts already translated
            still are.
          </p>
        )}

        <PostActions
          slug={slug}
          guid={String(post.guid)}
          score={score.score}
          liked={mine.liked}
          vote={mine.vote}
          signedIn={Boolean(userId)}
        />
      </div>

      {/*
       * The whole post, in the reader's language, in place of the frame.
       *
       * dangerouslySetInnerHTML with two untrusted authors behind it — the
       * publisher and the model — so nothing reaches here that has not been
       * through sanitizeHtml, which is an allowlist and drops scripts,
       * handlers, embeds and unsafe URL schemes.
       */}
      {watchable ? (
        <>
          {/*
           * The player, where the article would be, with the video loaded and
           * one click from playing. Nothing is autoplayed: a video that starts
           * talking because somebody opened a page is the behaviour every
           * reader of this directory left somewhere else to avoid.
           */}
          <EpisodePlayer
            inline
            attached={!episode}
            kind={media.kind}
            src={media.src}
            type={mediaType}
            title={title}
            seconds={post.audio_seconds ? Number(post.audio_seconds) : null}
            feedTitle={String(feed.title)}
          />

          {summary && <p className={`lede${translated ? ' translated' : ''}`}>{summary}</p>}

          {/* The body, whether it is show notes or a whole article.
            *
            * This was gated on `!summary`, and that gate was the bug: a feed
            * that ships both a <description> and a full <content:encoded> — a
            * WordPress blog, which is most of them — had the article thrown
            * away and the two-line excerpt shown in its place. The reader had
            * the post and refused to render it. There is no case where having
            * an excerpt is a reason to withhold the text it is an excerpt of.
            */}
          {article && (
            <article
              className={`reader-article${translated ? ' translated' : ''}`}
              lang={translated ? (wanted ?? undefined) : undefined}
              dangerouslySetInnerHTML={{ __html: article }}
            />
          )}

          {postUrl && (
            <p className="hint">
              <a href={postUrl} target="_blank" rel="noopener">
                {episode ? 'Watch on' : 'Read the original on'} {hostOf(postUrl)} ↗
              </a>
            </p>
          )}

          {/* No ad here, for the reason the framed branch has none: what fills
              the screen is somebody else's video, and selling space around it
              would be earning off their work. */}
        </>
      ) : readable ? (
        <>
          {summary && <p className="lede translated">{summary}</p>}
          <article
            className="reader-article translated"
            lang={wanted ?? undefined}
            dangerouslySetInnerHTML={{ __html: article ?? '' }}
          />

          {translated?.truncated && (
            <p className="notice">
              This post was longer than one translation, so it stops partway. The rest is on the
              original site — the toolbar below has the link.
            </p>
          )}

          {postUrl && (
            <p className="hint">
              <a href={postUrl} target="_blank" rel="noopener">
                Read the original on {hostOf(postUrl)} ↗
              </a>
            </p>
          )}
        </>
      ) : (
        <>
          {/*
           * Not translated, so the frame stands and the summary sits above it:
           * the frame is the publisher's own page in its own language, and
           * this is the gist in the reader's, so they can decide whether the
           * page below is worth the effort.
           */}
          {translated && summary && verdict.frameable && (
            <p className="lede translated">{summary}</p>
          )}

          {framed && postUrl ? (
            <iframe
              className="reader-frame"
              // Not the publisher's URL, which is what this used to be, and
              // what made the frame a one-click surface: a link inside it
              // loads *into* it, and most of the web refuses to be framed, so
              // the second click landed on "refused to connect" in the middle
              // of the reader. Serving the page through /api/frame is what
              // makes its links ours to point somewhere that opens — the page
              // is still theirs, and still assembled from their server.
              //
              // It costs the publisher nothing extra: the request the browser
              // used to make for the document is the request we make instead.
              src={`/api/frame?u=${encodeURIComponent(postUrl)}`}
              title={title}
              // The framed page is a stranger's: allow it to render and
              // navigate itself, and nothing else. No same-origin — so even
              // though it is now served from our host, it runs with no origin
              // at all and can never reach into this document. The response
              // says the same thing in a header, for anyone who loads it
              // outside this frame.
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
              referrerPolicy="no-referrer-when-downgrade"
              loading="eager"
            />
          ) : extracted ? (
            <>
              {/*
               * The article, read off the page the site would not let us frame.
               *
               * This is the branch that used to be a dead end: a notice saying
               * the site refuses to be embedded, a one-line summary, and a
               * button sending the reader somewhere else to do the one thing
               * they came here for. The refusal is still real — it is why the
               * frame is not here — but it is no longer the reader's problem,
               * so it is not the reader's notice either.
               *
               * Sanitized on the way into the database, by the same allowlist
               * every other body on this page goes through.
               */}
              <p className="meta">
                {extracted.byline ? `${extracted.byline} · ` : ''}
                {extracted.siteName ?? hostOf(postUrl ?? '')}
              </p>

              <article className="reader-article" dangerouslySetInnerHTML={{ __html: extracted.html }} />

              {postUrl && (
                <p className="hint">
                  <a href={postUrl} target="_blank" rel="noopener">
                    Read the original on {hostOf(postUrl)} ↗
                  </a>
                </p>
              )}

              {/*
               * No ad, and the reason is the one already written a few lines
               * down: an ad here would be money made off somebody else's
               * writing. That this page rendered their article rather than
               * framing it changes how it got here, not whose it is.
               */}
            </>
          ) : listenable ? (
            <>
              {/*
               * The post, playing, where the refusal notice used to be.
               *
               * Inline rather than docked for the reason the video branch is:
               * this is the thing the reader came for, and the alternative on
               * offer is an apology in the middle of the screen with the actual
               * post shrunk into the corner beneath it. Still `preload="none"`
               * — nothing has been said about wanting to hear it yet.
               */}
              <EpisodePlayer
                inline
                attached={!episode}
                kind={media.kind}
                src={media.src}
                type={mediaType}
                title={title}
                seconds={post.audio_seconds ? Number(post.audio_seconds) : null}
                feedTitle={String(feed.title)}
              />

              {summary && <p className={`lede${translated ? ' translated' : ''}`}>{summary}</p>}

              {/* Show notes, or an article the audio came attached to.
                  Withheld only when it is the summary again — a track whose
                  feed puts the same sentence in <description> and <content>
                  printed "Acoustic guitar that I recorded at home" twice,
                  once as the lede and once as the body. Not the fallback
                  branch's `!summary` gate, which throws away a whole article
                  whenever a feed also shipped an excerpt of it. */}
              {article && !repeats(article, summary) && (
                <article
                  className={`reader-article${translated ? ' translated' : ''}`}
                  lang={translated ? (wanted ?? undefined) : undefined}
                  dangerouslySetInnerHTML={{ __html: article }}
                />
              )}

              {postUrl && (
                <p className="hint">
                  <a href={postUrl} target="_blank" rel="noopener">
                    {episode ? 'Listen on' : 'Read the original on'} {hostOf(postUrl)} ↗
                  </a>
                </p>
              )}

              {/*
               * An ad, unlike the video branch, and the difference is what is
               * on screen. A video fills the column, so a unit beside it is
               * sold against somebody else's work. An audio transport is a
               * strip: the page around it is this summary and this link, the
               * same page the fallback branch below carries a unit on.
               */}
              <Ad format={AD_MREC} />
            </>
          ) : (
            <div className="reader-fallback">
              <p className="notice">
                {explain(verdict.reason)} You can still read it on the original site — the toolbar
                below keeps your place in the directory.
              </p>

              {summary && <p className={`lede${translated ? ' translated' : ''}`}>{summary}</p>}

              {/* The post's own text, where the publisher put it in the feed.
                  Better than a link nobody can follow when the site refuses to
                  be framed — which is most of the reason this branch exists. */}
              {article && !summary && (
                <article className="reader-article" dangerouslySetInnerHTML={{ __html: article }} />
              )}

              {postUrl && (
                <p>
                  <a className="button" href={postUrl} target="_blank" rel="noopener">
                    Read on {hostOf(postUrl)} ↗
                  </a>
                </p>
              )}

              {/*
               * The only advertising in the reader, and only on this branch.
               *
               * When the frame loads, everything on screen is somebody else's
               * article and the money an ad made here would be made off their
               * writing. That is the same reason this page is already noindex
               * — it must not compete with the original — and selling space
               * around it would be the same trespass with a bill attached.
               *
               * This branch is different: nothing was framed, so the page is
               * our own summary and our own link out, and it can carry a unit.
               */}
              <Ad format={AD_MREC} />
            </div>
          )}
        </>
      )}

      <Comments slug={slug} guid={String(post.guid)} comments={thread} userId={userId} />

      {/* Docked above the toolbar, so the episode keeps playing while the
          show notes scroll behind it. Audio only: a video is already playing
          up where the article would be, and two players on one page is one
          player too many. Same reason `listenable` is excluded — that branch
          moved this player up into the post. */}
      {audio && !watchable && !listenable && (
        <EpisodePlayer
          kind={media.kind}
          src={media.src}
          type={mediaType}
          title={title}
          seconds={post.audio_seconds ? Number(post.audio_seconds) : null}
          feedTitle={String(feed.title)}
        />
      )}

      <ReaderToolbar
        slug={slug}
        feedTitle={String(feed.title)}
        postUrl={postUrl}
        framed={framed}
        prevGuid={inOrder && index > 0 ? String(posts[index - 1].guid) : null}
        nextGuid={inOrder && index < posts.length - 1 ? String(posts[index + 1].guid) : null}
        nextBlog={nav.next}
      />
    </div>
  );
}

/**
 * Does this body say only what the summary already said?
 *
 * The two are different fields and usually different lengths — a description
 * and the post it describes — but plenty of feeds put one sentence in both,
 * and then a page that renders both shows the reader the same sentence twice.
 *
 * Equality rather than "the summary is a prefix of the body", which is the
 * ordinary excerpt-and-article case and exactly the one worth rendering: the
 * summary is the first paragraph, and the body is the other twenty.
 *
 * @param {string} html the body, as it will be rendered
 * @param {unknown} summary
 * @returns {boolean}
 */
function repeats(html, summary) {
  const text = (value) =>
    String(value ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const gist = text(summary);
  return gist.length > 0 && text(html) === gist;
}

/**
 * Say why a page could not be framed, in words a reader can act on.
 *
 * @param {string} reason
 * @returns {string}
 */
function explain(reason) {
  if (reason.startsWith('x-frame-options') || reason === 'csp-frame-ancestors') {
    return 'This site does not allow itself to be embedded.';
  }
  if (reason === 'timeout') return 'This site took too long to answer.';
  if (reason.startsWith('http-')) return 'This page did not load.';
  return 'This page cannot be shown here.';
}

/**
 * @param {unknown} iso
 * @returns {string}
 */
function formatDate(iso) {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
