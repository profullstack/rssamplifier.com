/**
 * The charts on /crawlstats.
 *
 * Every one of them is server-rendered SVG with no script behind it, because
 * the rest of the site works with JavaScript off and a status board is the last
 * page that should need a bundle to draw a bar.
 *
 * Two rules shape how they are built:
 *
 * 1. **No text inside the SVG.** An <svg> with a viewBox scales everything in
 *    it, type included, so axis labels set at 11px render at 16px on a wide
 *    screen and at 5px on a phone. The marks scale; the labels are HTML
 *    alongside them and keep the page's own type scale at every width.
 *
 * 2. **The numbers are readable without the picture.** Each bar carries a
 *    <title>, which is a tooltip in a browser and a label to a screen reader,
 *    and each chart ships the series as a table behind a <details>. A chart
 *    nobody can read the values off is decoration.
 */

/*
 * Plot geometry, in viewBox units. Bars are drawn edge to edge; labels are HTML.
 *
 * The ratio is the whole design here — an SVG with a viewBox scales to whatever
 * width it lands in, so the only thing these numbers fix is how tall the chart
 * is at that width. The bar charts sit two to a row on a wide screen and one on
 * a phone, so they need to survive being half as wide; the growth curve is
 * always full width and is shallower to match.
 */
const W = 720;
const H = 190;
const LINE_H = 140;

/** Rounded data-ends, anchored to the baseline. */
const RADIUS = 3;

/** A bar for a non-zero hour never rounds away to nothing. */
const MIN_BAR = 2;

/**
 * Posts stored per hour.
 *
 * The question this answers is "is the crawler still ingesting?", so it is one
 * series and needs no legend — the caption names it.
 *
 * @param {{ series: Array<{ hour: string, items: number, recorded: boolean }> }} props
 */
export function IndexingChart({ series }) {
  if (series.length === 0) return <Unavailable title="Posts indexed per hour" />;

  const max = niceMax(Math.max(...series.map((h) => h.items), 1));
  const step = W / series.length;
  const width = Math.max(1, step - 2);
  const peak = series.reduce((a, b) => (b.items > a.items ? b : a), series[0]);
  const total = series.reduce((n, h) => n + h.items, 0);

  return (
    <figure className="chart">
      <figcaption className="chart-title">
        Posts indexed per hour
        <span className="chart-note">
          {fmt(total)} in {series.length}h · peak {fmt(peak?.items ?? 0)} at {hourLabel(peak?.hour)}
        </span>
      </figcaption>

      <svg
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Posts indexed each hour over the last ${series.length} hours. ${fmt(total)} in total, peaking at ${fmt(peak?.items ?? 0)}.`}
      >
        <Grid />
        {series.map((hour, i) => {
          const height = barHeight(hour.items, max);
          if (height === 0) return <Empty key={hour.hour} x={i * step} label={`${hourLabel(hour.hour)} · no posts`} width={width} />;

          return (
            <path
              key={hour.hour}
              className="chart-mark-1"
              d={bar(i * step, H - height, width, height)}
            >
              <title>{`${hourLabel(hour.hour)} · ${fmt(hour.items)} posts`}</title>
            </path>
          );
        })}
      </svg>

      <HourAxis series={series} />
      <HourTable
        series={series}
        columns={[{ key: 'items', label: 'Posts' }]}
        caption="Posts indexed per hour"
      />
    </figure>
  );
}

/**
 * Feeds fetched per hour, split by outcome.
 *
 * Stacked rather than side by side: the pair is a composition — every fetch is
 * either a success or a failure — and the total height is the number a reader
 * is looking for first.
 *
 * Hours from before the rollup existed are drawn as a rule on the baseline
 * rather than as a zero bar. The crawler was working then; nobody was writing
 * it down, and a chart that draws those the same way reports an outage that
 * never happened.
 *
 * @param {{ series: Array<{ hour: string, fetched: number, succeeded: number, failed: number, recorded: boolean }> }} props
 */
export function ThroughputChart({ series }) {
  if (series.length === 0) return <Unavailable title="Feeds crawled per hour" />;

  const max = niceMax(Math.max(...series.map((h) => h.fetched), 1));
  const step = W / series.length;
  const width = Math.max(1, step - 2);
  const recorded = series.filter((h) => h.recorded);
  const fetched = recorded.reduce((n, h) => n + h.fetched, 0);
  const failed = recorded.reduce((n, h) => n + h.failed, 0);

  return (
    <figure className="chart">
      <figcaption className="chart-title">
        Feeds crawled per hour
        <span className="chart-note">
          {recorded.length === 0
            ? 'no hours recorded yet'
            : `${fmt(fetched)} fetched · ${pct(failed, fetched)} failed`}
        </span>
      </figcaption>

      <svg
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Feeds fetched each hour over the last ${series.length} hours, split into successes and failures. ${fmt(fetched)} fetched, ${fmt(failed)} of them failed.`}
      >
        <Grid />
        {series.map((hour, i) => {
          if (!hour.recorded) {
            return (
              <Empty key={hour.hour} x={i * step} width={width} label={`${hourLabel(hour.hour)} · not recorded`} />
            );
          }

          const ok = barHeight(hour.succeeded, max);
          const bad = barHeight(hour.failed, max);
          // A 2px hole between the segments, so the boundary is the surface
          // showing through rather than two fills touching.
          const gap = ok > 0 && bad > 0 ? 2 : 0;
          const x = i * step;

          if (ok === 0 && bad === 0) {
            return <Empty key={hour.hour} x={x} width={width} label={`${hourLabel(hour.hour)} · nothing due`} />;
          }

          return (
            <g key={hour.hour}>
              <title>{`${hourLabel(hour.hour)} · ${fmt(hour.succeeded)} crawled, ${fmt(hour.failed)} failed`}</title>
              {ok > 0 && (
                <path
                  className="chart-mark-1"
                  d={
                    bad > 0
                      ? square(x, H - ok, width, ok)
                      : bar(x, H - ok, width, ok)
                  }
                />
              )}
              {bad > 0 && (
                <path className="chart-mark-2" d={bar(x, H - ok - gap - bad, width, bad)} />
              )}
            </g>
          );
        })}
      </svg>

      <HourAxis series={series} />

      <ul className="chart-legend">
        <li>
          <span className="chart-swatch chart-swatch-1" aria-hidden="true" /> Crawled
        </li>
        <li>
          <span className="chart-swatch chart-swatch-2" aria-hidden="true" /> Failed
        </li>
      </ul>

      <HourTable
        series={series}
        columns={[
          { key: 'succeeded', label: 'Crawled' },
          { key: 'failed', label: 'Failed' },
        ]}
        caption="Feeds crawled per hour"
      />
    </figure>
  );
}

/**
 * How many feeds the directory has held, day by day.
 *
 * Reconstructed from when each feed was added rather than from a rollup, so it
 * is accurate back to the first row in the table — and it is cumulative, which
 * is the shape that survives a bulk import: an import shows as a step rather
 * than as a spike that flattens every other day into the axis.
 *
 * @param {{ days: string[], values: number[] }} props
 */
export function GrowthChart({ days, values }) {
  if (values.length === 0) return <Unavailable title="Directory growth" />;

  const first = values[0] ?? 0;
  const last = values.at(-1) ?? 0;
  const top = niceMax(Math.max(...values, 1));
  // Zeroed, not zoomed. A cumulative count read off a truncated axis turns a
  // 1% week into a cliff, and this chart's whole job is the shape of growth.
  const x = (i) => (values.length === 1 ? W / 2 : (i / (values.length - 1)) * W);
  const y = (v) => LINE_H - (v / top) * (LINE_H - 4) - 2;

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');

  return (
    <figure className="chart chart-wide">
      <figcaption className="chart-title">
        Directory growth
        <span className="chart-note">
          {fmt(last)} feeds · {last - first >= 0 ? '+' : ''}
          {fmt(last - first)} in {days.length} days
        </span>
      </figcaption>

      <svg
        className="chart-svg"
        viewBox={`0 0 ${W} ${LINE_H}`}
        role="img"
        aria-label={`Feeds in the directory each day for ${days.length} days, from ${fmt(first)} on ${days[0]} to ${fmt(last)} on ${days.at(-1)}.`}
      >
        <Grid height={LINE_H} />
        <path className="chart-area-1" d={`${line} L${W} ${LINE_H} L0 ${LINE_H} Z`} />
        <path className="chart-line-1" d={line} />
        <circle className="chart-dot-1" cx={W} cy={y(last)} r="4" />
        {values.map((v, i) => (
          // An invisible column per day, so hovering anywhere over a date
          // names it. The line itself is 2px and impossible to hit.
          <rect
            key={days[i]}
            x={x(i) - W / values.length / 2}
            y="0"
            width={W / values.length}
            height={LINE_H}
            fill="transparent"
          >
            <title>{`${days[i]} · ${fmt(v)} feeds`}</title>
          </rect>
        ))}
      </svg>

      <ol className="chart-axis" aria-hidden="true">
        <li>{dayLabel(days[0])}</li>
        <li>{dayLabel(days[Math.floor(days.length / 2)])}</li>
        <li>{dayLabel(days.at(-1))}</li>
      </ol>
    </figure>
  );
}

/**
 * One category's curve, at its own scale, small enough to sit in a table cell.
 *
 * Its own scale is the point: 47,000 blogs and 36 livestreams cannot share a y
 * axis without the livestreams becoming a flat line on the floor. Small
 * multiples compare *shape* — is this category growing? — and the count beside
 * it in the same row carries the magnitude.
 *
 * @param {{ values: number[], label: string }} props
 */
export function Sparkline({ values, label }) {
  if (values.length < 2 || values.at(-1) === 0) return <span className="spark-empty">—</span>;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 96;
  const h = 22;
  const x = (i) => (i / (values.length - 1)) * w;
  const y = (v) => h - 2 - ((v - min) / span) * (h - 4);

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');

  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <path className="chart-line-1" d={line} />
      <circle className="chart-dot-1" cx={w} cy={y(values.at(-1))} r="2.5" />
    </svg>
  );
}

/**
 * Four recessive horizontal rules at quarters of the scale. The scale itself is
 * in the caption; a gridline's job here is to let the eye compare two bars
 * across the width of the chart, not to be read off.
 *
 * @param {{ height?: number }} props
 */
function Grid({ height = H }) {
  return (
    <g className="chart-rules" aria-hidden="true">
      {[0, 0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" x2={W} y1={height * f + 0.5} y2={height * f + 0.5} />
      ))}
      <line x1="0" x2={W} y1={height - 0.5} y2={height - 0.5} className="chart-baseline" />
    </g>
  );
}

/**
 * A chart with no series behind it.
 *
 * Says so, in the space the chart would occupy, rather than drawing an empty
 * grid — an axis with nothing on it reads as "zero", and the answer here is
 * "unknown". See the fallbacks in lib/crawlstats.js for when this happens.
 *
 * @param {{ title: string }} props
 */
function Unavailable({ title }) {
  return (
    <figure className="chart">
      <figcaption className="chart-title">
        {title}
        <span className="chart-note">no history to draw yet</span>
      </figcaption>
    </figure>
  );
}

/**
 * A slot with nothing in it, drawn as a rule on the baseline so the hour is
 * still hoverable and still visibly *there*.
 *
 * @param {{ x: number, width: number, label: string }} props
 */
function Empty({ x, width, label }) {
  return (
    <rect className="chart-empty" x={x} y={H - 2} width={width} height="2">
      <title>{label}</title>
    </rect>
  );
}

/**
 * Time labels under an hourly chart: first, last, and a few in between.
 *
 * @param {{ series: Array<{ hour: string }> }} props
 */
function HourAxis({ series }) {
  const at = [0, Math.floor(series.length / 3), Math.floor((series.length * 2) / 3), series.length - 1];

  return (
    <ol className="chart-axis" aria-hidden="true">
      {at.map((i) => (
        <li key={series[i]?.hour ?? i}>{hourLabel(series[i]?.hour)}</li>
      ))}
    </ol>
  );
}

/**
 * The same series as a table, folded away.
 *
 * @param {{ series: object[], columns: Array<{ key: string, label: string }>, caption: string }} props
 */
function HourTable({ series, columns, caption }) {
  return (
    <details className="chart-data">
      <summary>Show the numbers</summary>
      <table className="crawl-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Hour (UTC)</th>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...series].reverse().map((row) => (
            <tr key={row.hour}>
              <td>{row.hour.replace('T', ' ')}:00</td>
              {columns.map((c) => (
                // A rollup row that predates the recording only knows its item
                // count; showing 0 crawls for those hours would be a lie.
                <td key={c.key} className="num">
                  {row.recorded || c.key === 'items' ? fmt(row[c.key]) : '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/**
 * A bar with rounded top corners, sitting on the baseline.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @returns {string}
 */
function bar(x, y, w, h) {
  const r = Math.max(0, Math.min(RADIUS, w / 2, h));
  return `M${x.toFixed(1)} ${(y + h).toFixed(1)} L${x.toFixed(1)} ${(y + r).toFixed(1)} Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)} L${(x + w - r).toFixed(1)} ${y.toFixed(1)} Q${(x + w).toFixed(1)} ${y.toFixed(1)} ${(x + w).toFixed(1)} ${(y + r).toFixed(1)} L${(x + w).toFixed(1)} ${(y + h).toFixed(1)} Z`;
}

/**
 * A plain rectangle, for the lower half of a stack — only the top of a stack
 * gets rounded, or the segments look like separate bars.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @returns {string}
 */
function square(x, y, w, h) {
  return `M${x.toFixed(1)} ${y.toFixed(1)} h${w.toFixed(1)} v${h.toFixed(1)} h${(-w).toFixed(1)} Z`;
}

/**
 * @param {number} value
 * @param {number} max
 * @returns {number} height in viewBox units, 0 for nothing at all
 */
function barHeight(value, max) {
  if (!value) return 0;
  return Math.max(MIN_BAR, (value / max) * (H - 6));
}

/**
 * Round a maximum up to something a gridline can sit on.
 *
 * @param {number} n
 * @returns {number}
 */
function niceMax(n) {
  const magnitude = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / magnitude) * magnitude;
}

/**
 * @param {number} n
 * @returns {string}
 */
function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

/**
 * @param {number} part
 * @param {number} whole
 * @returns {string}
 */
function pct(part, whole) {
  if (!whole) return '0%';
  const value = (part / whole) * 100;
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`;
}

/**
 * '2026-08-17T03' → '03:00'.
 *
 * @param {string|undefined} hour
 * @returns {string}
 */
function hourLabel(hour) {
  if (!hour) return '';
  return `${hour.slice(11, 13)}:00`;
}

/**
 * '2026-08-17' → '17 Aug'.
 *
 * @param {string|undefined} day
 * @returns {string}
 */
function dayLabel(day) {
  if (!day) return '';
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}
