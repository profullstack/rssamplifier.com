import { LANE_VERB } from '../lib/queue.js';

/**
 * Put a post in the reader's queue, or take it back out.
 *
 * One plain form per lane, posting to /api/queue like every other control on
 * the site: no client bundle, works with JavaScript off, and the 303 comes back
 * to the page the button was on rather than to the queue.
 *
 * `data-soft` is the one enhancement, and it is entirely optional — the docked
 * player picks these forms up and posts them in the background so that queueing
 * something does not reload the page out from under whatever is playing. With
 * no JavaScript the form submits itself and the reader loses their place in the
 * audio, which is the behaviour they would have had anyway.
 *
 * A signed-out reader gets the button too, and the endpoint sends them to sign
 * in and back. Hiding it would mean reading the session on pages that are
 * otherwise static, and telling somebody the feature does not exist is a worse
 * answer than asking them to sign in.
 *
 * @param {{
 *   slug: string,
 *   guid: string,
 *   lanes: ('read'|'listen'|'watch')[],
 *   queued?: ('read'|'listen'|'watch')[],
 *   next: string,
 *   compact?: boolean,
 * }} props
 */
export default function QueueButton({ slug, guid, lanes, queued = [], next, compact = false }) {
  return (
    <span className={`queue-actions${compact ? ' compact' : ''}`}>
      {lanes.map((lane) => {
        const inQueue = queued.includes(lane);

        return (
          <form key={lane} method="post" action="/api/queue" className="inline-form" data-soft>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="guid" value={guid} />
            <input type="hidden" name="lane" value={lane} />
            <input type="hidden" name="action" value={inQueue ? 'remove' : 'add'} />
            <input type="hidden" name="next" value={next} />
            <button
              type="submit"
              className={`queue-button${inQueue ? ' on' : ''}`}
              // aria-pressed, because this is a toggle in a state and not two
              // different buttons that happen to occupy one place.
              aria-pressed={inQueue}
              title={inQueue ? `Remove from your ${lane} queue` : LANE_VERB[lane]}
            >
              {/* An ASCII plus, not the fullwidth one it started as: that
                  renders as an empty box wherever the core fonts are all
                  there is. */}
              <span aria-hidden="true">{inQueue ? '✓' : '+'}</span>
              <span className="label">{inQueue ? 'Queued' : LANE_VERB[lane]}</span>
            </button>
          </form>
        );
      })}
    </span>
  );
}
