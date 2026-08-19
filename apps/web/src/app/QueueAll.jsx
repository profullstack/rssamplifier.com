import { LANE_LABEL } from '../lib/queue.js';

/**
 * Put a whole playlist in the reader's queue, or take it back out.
 *
 * A playlist is the one place on the site where "save this for later" was
 * impossible: fifty episodes of a topic, a play button on each, and no way to
 * keep any of them. The per-row buttons fix that one at a time; this is the
 * other half, because forty of the fifty is what somebody actually wants and
 * pressing forty buttons is not a feature.
 *
 * It names the playlist rather than carrying it. The form posts the topic and
 * the category segment, and the endpoint re-runs the query the page was drawn
 * from — so the button adds exactly what is listed below it, in the order it is
 * listed, and the form stays three hidden inputs instead of four kilobytes of
 * guids.
 *
 * A toggle rather than a pair of buttons, on the same reading the per-post
 * button uses: once everything here is queued, the useful next action is
 * undoing it, and it should undo *this* rather than empty the lane and take the
 * rest of the reader's queue with it.
 *
 * Names either a topic or a single feed. Both post the same shape to the same
 * endpoint and differ only in which query the server re-runs, so a feed page
 * gets the control it was missing without a second component drifting away from
 * this one.
 *
 * @param {{
 *   topic?: string|null,
 *   feed?: string|null,
 *   group?: string|null,
 *   total: number,
 *   queued: number,
 *   lanes: ('read'|'listen'|'watch')[],
 *   next: string,
 * }} props
 */
export default function QueueAll({
  topic = null,
  feed = null,
  group = null,
  total,
  queued,
  lanes,
  next,
}) {
  if (total === 0) return null;

  // Which playlist this is, and therefore which pair of actions it posts.
  const scope = feed ? 'feed' : 'topic';

  // "All of it" rather than "every single one": a playlist whose entries are
  // already in the queue for other reasons should not offer to add them again.
  const all = queued >= total;
  const some = queued > 0 && !all;

  // Where they land, in the reader's own words. Worth saying because a mixed
  // playlist splits — the episodes into Listen, the videos into Watch — and a
  // reader who was told "queued" and then found nothing in the lane they were
  // looking at would reasonably conclude the button was broken.
  const where = lanes.map((lane) => LANE_LABEL[lane]).join(' and ');

  return (
    <div className="queue-all">
      <form method="post" action="/api/queue" className="inline-form" data-soft>
        <input type="hidden" name="action" value={`${all ? 'remove' : 'add'}-${scope}`} />
        {feed ? (
          <input type="hidden" name="slug" value={feed} />
        ) : (
          <input type="hidden" name="topic" value={topic} />
        )}
        {group && <input type="hidden" name="group" value={group} />}
        <input type="hidden" name="next" value={next} />
        <button type="submit" className={`queue-button${all ? ' on' : ''}`} aria-pressed={all}>
          <span aria-hidden="true">{all ? '✓' : '+'}</span>
          <span className="label">
            {all ? `Remove all ${total} from your queue` : `Queue all ${total}`}
          </span>
        </button>
      </form>

      <p className="queue-all-note">
        {all ? (
          <>
            All of this is in your <a href={`/queue?lane=${lanes[0] ?? 'listen'}`}>{where}</a>{' '}
            queue.
          </>
        ) : some ? (
          <>
            {queued} of these {queued === 1 ? 'is' : 'are'} already in your{' '}
            <a href={`/queue?lane=${lanes[0] ?? 'listen'}`}>{where}</a> queue.
          </>
        ) : (
          <>Saves to your {where} queue, to pick up on another day or another device.</>
        )}
      </p>
    </div>
  );
}
