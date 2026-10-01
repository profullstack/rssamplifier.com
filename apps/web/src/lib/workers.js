/**
 * How many copies of the server to run, and how much heap to give each.
 *
 * ## The outage this exists to prevent
 *
 * On 2026-09-07 the site was dark while twenty-two of its twenty-four CPUs sat
 * idle. A residential-proxy fleet was walking `/topics/*`, `/api/topics/*` and
 * the reader at roughly 140 requests a second — five hundred requests from five
 * hundred distinct addresses, no path asked for twice, so neither the throttle
 * (which meters a caller) nor any cache (which needs a repeat) touched a single
 * one of them. The container held one `node server.mjs`. Rendering a topic page
 * costs around 150 ms of JavaScript, and JavaScript runs on one thread, so the
 * whole site could serve about seven requests a second no matter how much
 * hardware it was standing on. Everything above that queued behind the
 * in-flight ceiling, the event loop never got back to `accept()`, and the edge
 * proxy started reporting `connection dial timeout` — the site was down for
 * readers too, not only for the fleet.
 *
 * The 2026-09-03 incident that `loadShed.js` was written for was a memory
 * problem and the ceiling was the right answer to it. This is a different
 * failure with the same symptom: not enough of the machine was being used. A
 * ceiling protects a process that is working too hard; it cannot make a process
 * work on more than one thing at a time.
 *
 * ## What this does not fix
 *
 * Capacity is not a defence. Running the server on every core raises what the
 * site can absorb by more than an order of magnitude, which is enough to absorb
 * *this* fleet, and a fleet twice the size would put it back where it started.
 * The thing that actually stops a distributed scrape is refusing it before it
 * costs a render — see the note in `crawlThrottle.js` about limits keyed on who
 * is asking, and `rssamplifier-residential-proxy-fleet` for why the header
 * checks in the gateway do not catch this one. This module buys the room to go
 * build that; it is not that.
 *
 * ## Reading the budget from the cgroup, not from `os`
 *
 * `os.availableParallelism()` reports the *host's* CPUs — 48 on this Railway
 * machine — while the container is allowed 24. Forking a worker per host CPU
 * would put twice as many runnable threads on the quota as it can run, and the
 * scheduler would spend the difference on context switches. The same trap
 * applies to memory: `os.totalmem()` is the host's 393 GB and the container's
 * limit is 24 GB. Both budgets come from the cgroup, and only fall back to the
 * `os` numbers when there is no cgroup to read (a developer's laptop).
 *
 * ## Why "every core" stopped being the default (2026-10-01)
 *
 * On Railway the cgroup was the budget and it was a sensible one: 24 CPUs and
 * 24 GB that belonged to this service alone. On dev2 there is no cgroup limit
 * at all. The container sees the host — 32 CPUs and 91 GB — and that host is
 * shared with every other site on the box, including the Postgres this one
 * reads from. Reading "no limit" as "all of it" forked sixteen workers and
 * handed each a 3.5 GB heap ceiling, 56 GB of promises on a machine whose other
 * tenants were already using most of it.
 *
 * Nothing leaked. A worker's RSS climbed with its age and then levelled off —
 * about 290 MB at nine hours, 400 MB at a day, 970 MB at six days — which is V8
 * doing what it is told: with a ceiling that high it has no reason to collect
 * hard, so it doesn't, and garbage that would have been reclaimed at 1 GB sits
 * in the heap instead. Sixteen of those came to 11.7 GB, the host's swap filled,
 * and earlyoom started killing processes to make room — including the shared
 * Postgres, which took down far more than this site.
 *
 * So the defaults are now sized for a tenant, not an owner. The count is capped
 * at `DEFAULT_WORKERS` unless `WEB_WORKERS` says otherwise, and the heap is a
 * fixed total (`WEB_HEAP_BUDGET_MB`) divided between the workers, so the
 * container's memory no longer depends on how many workers there are or on what
 * the host happens to have. Turning `WEB_WORKERS` up during a flood buys CPU
 * without buying memory: the same budget is cut into smaller pieces.
 *
 * That gives back some of the 2026-09-07 headroom on purpose. Four workers
 * measured 50 req/s locally against 28 for one; the fleet that day asked for
 * 140. Four was never going to win that fight on capacity alone and neither was
 * sixteen against a fleet twice the size — the section above is still the
 * argument. What four does is keep a flood from becoming the whole box's
 * problem. `WEB_WORKERS` is still there for the day it needs to be higher.
 */

import cluster from 'node:cluster';
import { readFileSync } from 'node:fs';
import os from 'node:os';

/**
 * The most workers to run, even when `WEB_WORKERS` asks for more.
 *
 * Each worker is a whole Next server with its own module state, its own render
 * caches and its own heap, so the cost of one is real and the return falls off
 * once there are enough of them to keep the CPU quota busy. Sixteen was the
 * Railway container's whole quota and keeps the arithmetic on heap (below)
 * somewhere sane.
 */
const MAX_WORKERS = 16;

/**
 * How many workers to run when nobody has said.
 *
 * Four keeps most of what clustering won — 50 req/s against one process's 28
 * on the same build — at a quarter of sixteen's memory, and four is a share of
 * a shared box rather than all of it. A container with a CPU quota smaller than
 * this gets one worker per CPU, as before.
 */
const DEFAULT_WORKERS = 4;

/**
 * The heap ceiling for the whole container, in megabytes, when nobody has said.
 *
 * Divided between the workers, so four of them get about 1 GB each and one gets
 * all of it. A gigabyte is roomy for one worker: its in-flight share is 32
 * requests (`loadShed.js`), and the 2026-09-03 incident put a request's working
 * set at about 7 MB — 4 GB filled by six hundred of them — so a full worker is
 * holding a few hundred megabytes of work in progress, and the rest is Next and
 * its caches. A ceiling that close to the real need is also what makes V8
 * collect promptly instead of letting a worker drift toward a gigabyte over a
 * week, which is the whole of the dev2 problem described above.
 *
 * `WEB_HEAP_BUDGET_MB` overrides it.
 */
const DEFAULT_HEAP_BUDGET_MB = 4096;

/**
 * The share of the container's memory the workers may size their heaps to.
 *
 * Only binds when the container has a real limit smaller than the budget — on
 * Railway's 24 GB it never did, and on a container given, say, 4 GB it stops
 * the budget promising the workers more than exists. A `--max-old-space-size`
 * is a ceiling and not a reservation; what the fraction buys is the rest: the
 * build's own files in page cache, the parts of Next that are not heap, and the
 * headroom that makes the difference between a slow minute and the kernel
 * killing the container.
 */
const HEAP_FRACTION = 0.6;

/**
 * Never hand a worker less heap than this.
 *
 * The one place the total can be exceeded: sixteen workers on the default
 * budget would get 256 MB each, too little to render a big topic page, so they
 * get this instead and the total comes to 8 GB. Asking for sixteen is asking
 * for that.
 */
const MIN_HEAP_MB = 512;

/** Never hand a worker more than V8 would have taken on its own. */
const MAX_HEAP_MB = 12_288;

/**
 * Recycle a worker past this resident size when `WEB_WORKER_RSS_MB` is not set.
 *
 * The heap ceiling bounds the heap; it does not bound a worker's age creep.
 * Replaying two hours of real traffic (184,000 distinct paths from 112,000
 * addresses) against two four-worker pools side by side, one with the old
 * 2.4 GB-per-worker ceiling and one with 1 GB, every busy worker sat at
 * 370-430 MB resident after 30 minutes in both: same number, so the ceiling is
 * not what decides it. The heap left after a full collection was ~115 MB; the
 * rest is garbage not yet collected and memory the allocator keeps. On dev2 the
 * creep took a worker from ~400 MB at a day old to ~970 MB at six, which puts
 * 768 MB at about four days. So this recycles a worker every few days, not
 * every few minutes, and caps four workers at ~3 GB.
 */
const DEFAULT_RECYCLE_RSS_MB = 768;

/** How often the primary looks at its workers' resident size. */
const RECYCLE_CHECK_MS = 60_000;

/** How long a retiring worker gets to finish its requests before it is killed. */
const RETIRE_GRACE_MS = 30_000;

/**
 * An integer environment variable, or the fallback.
 *
 * Read through a non-literal property access for the reason `lib/db.js` gives,
 * and junk falls back rather than to some other number, for the reason
 * `pageGate.js` gives: a typo in a limit must not be the thing that removes it.
 *
 * @param {string} name
 * @returns {number | null}
 */
function envInt(name) {
  const env = process.env;
  const raw = Number(env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * The first line of a file, or null when it cannot be read.
 *
 * Every cgroup file this module wants is absent on a machine that is not a
 * container, and that is the ordinary case on a laptop rather than an error.
 *
 * @param {string} path
 * @returns {string | null}
 */
function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * How many CPUs this process may actually use at once.
 *
 * cgroup v2 states it as `quota period` in microseconds — `2400000 100000` is
 * 24 CPUs — and the literal `max` means no quota, in which case the host's
 * count is the truth. v1 splits the same pair across two files and writes `-1`
 * for no quota.
 *
 * @returns {number}
 */
export function cpuBudget() {
  const v2 = readOrNull('/sys/fs/cgroup/cpu.max');
  if (v2) {
    const [quota, period] = v2.split(/\s+/);
    if (quota !== 'max') {
      const cpus = Math.floor(Number(quota) / Number(period));
      if (cpus >= 1) return cpus;
    }
  }

  const quota = Number(readOrNull('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const period = Number(readOrNull('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  if (quota > 0 && period > 0) {
    const cpus = Math.floor(quota / period);
    if (cpus >= 1) return cpus;
  }

  return os.availableParallelism();
}

/**
 * How much memory this process may actually use, in bytes.
 *
 * Both cgroup versions write a sentinel when there is no limit — `max` in v2, a
 * number near 2^63 in v1 — and either means the host's total is the ceiling.
 *
 * @returns {number}
 */
export function memoryBudget() {
  const v2 = readOrNull('/sys/fs/cgroup/memory.max');
  if (v2 && v2 !== 'max') {
    const bytes = Number(v2);
    if (bytes > 0) return bytes;
  }

  const v1 = Number(readOrNull('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  if (v1 > 0 && v1 < os.totalmem() * 4) return v1;

  return os.totalmem();
}

/**
 * How many workers to run.
 *
 * `WEB_WORKERS` overrides, and `WEB_WORKERS=1` is the way back to the single
 * process this replaced — worth having, because a bug that only appears with
 * more than one of something is diagnosed by turning the something off. It is
 * also the dial for a flood: it may go above `DEFAULT_WORKERS` (up to
 * `MAX_WORKERS`) but never above `MAX_WORKERS`, and raising it does not raise
 * the container's memory — see `workerHeapMb`.
 *
 * Without it the count is the smaller of the CPU quota and `DEFAULT_WORKERS`.
 * The quota still matters for a container given fewer CPUs than that; it no
 * longer decides the count on a host with no quota, where it reports the whole
 * machine — the dev2 case in the header.
 *
 * @returns {number}
 */
export function workerCount() {
  const forced = envInt('WEB_WORKERS');
  if (forced) return Math.min(forced, MAX_WORKERS);

  return Math.max(1, Math.min(cpuBudget(), DEFAULT_WORKERS));
}

/**
 * The heap ceiling for the whole container, in megabytes.
 *
 * `WEB_HEAP_BUDGET_MB` when it is set to something sensible, otherwise
 * `DEFAULT_HEAP_BUDGET_MB` — and never more than `HEAP_FRACTION` of what the
 * container is actually allowed, so a small memory limit still wins over a big
 * budget.
 *
 * @returns {number}
 */
export function heapBudgetMb() {
  const asked = envInt('WEB_HEAP_BUDGET_MB') ?? DEFAULT_HEAP_BUDGET_MB;
  const allowed = Math.floor((memoryBudget() * HEAP_FRACTION) / (1024 * 1024));
  return Math.min(asked, allowed);
}

/**
 * The heap ceiling for one worker, in megabytes.
 *
 * The container's heap budget divided by the number of workers. The primary
 * passes it on the workers' command line, where it wins over the Dockerfile's
 * `NODE_OPTIONS` that every worker also inherits. With one worker the share is
 * the whole budget, which is what the Dockerfile's figure is for the single
 * process that `WEB_WORKERS=1` runs.
 *
 * Until 2026-10-01 this was a share of the container's *memory*, which was the
 * right answer on Railway's 24 GB and the wrong one on a host with no limit:
 * dev2 reported 91 GB and every worker was told it could have 3.5 of them.
 *
 * @param {number} [count] workers to divide the budget between
 * @returns {number}
 */
export function workerHeapMb(count = workerCount()) {
  const share = heapBudgetMb() / count;
  return Math.max(MIN_HEAP_MB, Math.min(MAX_HEAP_MB, Math.floor(share)));
}

/**
 * The resident size, in megabytes, past which a worker is replaced.
 *
 * `WEB_WORKER_RSS_MB`, or `DEFAULT_RECYCLE_RSS_MB`. A storm that pushes every
 * worker past it recycles them one a minute, each finishing its requests first.
 *
 * @returns {number}
 */
export function recycleRssMb() {
  return envInt('WEB_WORKER_RSS_MB') ?? DEFAULT_RECYCLE_RSS_MB;
}

/**
 * A process's resident set size in megabytes, from /proc, or null.
 *
 * The primary reads its workers from outside rather than asking them over IPC:
 * a worker that is in trouble is exactly the one that may not answer. Null off
 * Linux, which turns recycling off rather than breaking anything.
 *
 * @param {number | undefined} pid
 * @returns {number | null}
 */
export function rssMbOf(pid) {
  if (!pid) return null;
  const status = readOrNull(`/proc/${pid}/status`);
  const match = status?.match(/^VmRSS:\s+(\d+)\s+kB/m);
  return match ? Math.round(Number(match[1]) / 1024) : null;
}

/**
 * One worker's share of a limit that is meant to hold for the service.
 *
 * The in-flight ceiling is the case this exists for. It bounds the memory of
 * one process, so it has to be applied per worker — but the number it was sized
 * at, 128, was sized against a container, and leaving 128 on each of sixteen
 * workers would raise the real ceiling to 2,048 and give back the outage it was
 * written to prevent.
 *
 * Never below one, because a share that rounds to zero refuses everything.
 *
 * @param {number} total the whole service's allowance
 * @param {number} [count] workers to divide it between
 * @returns {number}
 */
export function share(total, count = workerCount()) {
  return Math.max(1, Math.round(total / count));
}

/**
 * Run `serve` in each of `workerCount()` worker processes.
 *
 * Returns false in a worker and in the single-worker case, meaning "you are the
 * one doing the work, get on with it". Returns true in a primary that has forked
 * — there is nothing else for that process to do, and it must not also bind the
 * port.
 *
 * A worker that dies is replaced. The alternative is a container that keeps
 * answering on fewer and fewer processes and never reports that it is degraded,
 * which is a worse failure than a restart: the platform's own restart policy
 * cannot see inside the container, so nothing else is watching these.
 *
 * A worker grown past `recycleRssMb()` is retired: a replacement is forked
 * first, and only once it is listening is the old one disconnected, so the
 * pool never drops below its size. Disconnecting stops the old worker taking
 * new connections and lets it finish the ones it has; if it has not exited
 * after a grace period it is terminated. One at a time, so a pool-wide problem
 * cannot turn into a pool-wide restart.
 *
 * @param {{
 *   onExit?: (info: { pid: number | undefined, code: number, signal: string | null }) => void,
 *   onRecycle?: (info: { pid: number | undefined, rssMb: number, limitMb: number }) => void,
 * }} [hooks]
 * @returns {boolean} true when this process is a primary that has forked workers
 */
export function forkWorkers(hooks = {}) {
  const count = workerCount();
  if (count <= 1 || !cluster.isPrimary) return false;

  cluster.setupPrimary({
    execArgv: [...process.execArgv, `--max-old-space-size=${workerHeapMb(count)}`],
  });

  for (let i = 0; i < count; i += 1) cluster.fork();

  /** Replacements forked by a recycle that are not listening yet. */
  const spares = new Set();
  /** A recycle is under way; one at a time. */
  let retiring = false;

  cluster.on('exit', (worker, code, signal) => {
    // A worker we retired already has its replacement, and a spare that died
    // before it took over leaves the worker it was replacing still serving.
    if (worker.exitedAfterDisconnect) return;
    if (spares.delete(worker)) {
      retiring = false;
      return;
    }
    hooks.onExit?.({ pid: worker.process.pid, code, signal });
    cluster.fork();
  });

  const limitMb = recycleRssMb();

  const check = setInterval(() => {
    if (retiring) return;
    const workers = Object.values(cluster.workers ?? {}).filter(
      (w) => w && !w.isDead() && !w.exitedAfterDisconnect,
    );
    for (const old of workers) {
      const rssMb = rssMbOf(old.process.pid);
      if (rssMb === null || rssMb <= limitMb) continue;

      retiring = true;
      hooks.onRecycle?.({ pid: old.process.pid, rssMb, limitMb });

      const replacement = cluster.fork();
      spares.add(replacement);
      replacement.once('listening', () => {
        spares.delete(replacement);
        if (old.isDead()) {
          // It died on its own meanwhile and the exit handler replaced it, so
          // this one is surplus.
          retiring = false;
          replacement.disconnect();
          return;
        }
        const kill = setTimeout(() => old.process.kill('SIGTERM'), RETIRE_GRACE_MS);
        kill.unref();
        old.once('exit', () => {
          clearTimeout(kill);
          retiring = false;
        });
        old.disconnect();
      });
      return;
    }
  }, RECYCLE_CHECK_MS);
  check.unref();

  return true;
}
