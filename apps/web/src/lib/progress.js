/**
 * What a run is waiting on, while there is nothing else to show.
 *
 * A keyword search takes about ninety seconds and writes nothing until it
 * returns, so a run opens on an empty log and a bar at zero for that whole
 * time — the exact "nothing is happening" impression the bar exists to
 * correct. Naming what is being waited on is the difference between a page
 * that looks stuck and one that is visibly working on something specific.
 *
 * It is deliberately only for that gap. As soon as the first candidate sites
 * exist the log carries the page by itself, and a second running commentary
 * would be noise on top of it — worse, it would be guessing, because by then
 * the inline search loop may have hit its budget and stopped.
 *
 * Which is also why the verb depends on the run. Inside the inline pass the
 * keywords are searched one at a time in the order they were queued, so the
 * oldest waiting one is genuinely in the provider's hands. Once the run has
 * been handed to the poller nothing is being searched at all, and saying so
 * is the honest version.
 *
 * @param {{ name?: string|null, left?: number, running?: boolean }|null} [searching]
 * @returns {string|null} a line to show, or null when there is nothing to say
 */
export function busyLine(searching) {
  const left = Number(searching?.left ?? 0);
  if (!Number.isFinite(left) || left < 1) return null;

  const name = searching?.name;

  if (!searching?.running) {
    if (!name) return `${left.toLocaleString()} keywords queued for the crawler…`;
    if (left === 1) return `“${name}” is queued for the crawler…`;
    return `“${name}” and ${(left - 1).toLocaleString()} more are queued for the crawler…`;
  }

  if (!name) return `searching — ${left.toLocaleString()} keywords left…`;
  if (left === 1) return `searching “${name}”…`;

  return `searching “${name}” — ${left.toLocaleString()} keywords left…`;
}
