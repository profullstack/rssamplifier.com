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
 */

import cluster from 'node:cluster';
import { readFileSync } from 'node:fs';
import os from 'node:os';

/**
 * The most workers to run whatever the machine offers.
 *
 * Each worker is a whole Next server with its own module state, its own render
 * caches and its own heap, so the cost of one is real and the return falls off
 * once there are enough of them to keep the CPU quota busy. Sixteen is above
 * what this container can run in parallel anyway and keeps the arithmetic on
 * heap (below) somewhere sane.
 */
const MAX_WORKERS = 16;

/**
 * The share of the container's memory the workers may size their heaps to.
 *
 * A `--max-old-space-size` is a ceiling and not a reservation, so the sum of
 * the workers' ceilings is allowed to exceed what the container has — every
 * worker reaching its ceiling at the same moment is not a state this survives
 * either way. What the fraction buys is the rest: the build's own files in page
 * cache, the copies of Next that are not heap, and the headroom that makes the
 * difference between a slow minute and the platform killing the container.
 */
const HEAP_FRACTION = 0.6;

/** Never hand a worker less heap than this. */
const MIN_HEAP_MB = 512;

/** Never hand a worker more than V8 would have taken on its own. */
const MAX_HEAP_MB = 12_288;

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
 * more than one of something is diagnosed by turning the something off.
 *
 * @returns {number}
 */
export function workerCount() {
  const forced = envInt('WEB_WORKERS');
  if (forced) return Math.min(forced, MAX_WORKERS);

  return Math.max(1, Math.min(cpuBudget(), MAX_WORKERS));
}

/**
 * The heap ceiling for one worker, in megabytes.
 *
 * The Dockerfile's `NODE_OPTIONS` sets a ceiling sized for one process holding
 * the whole container. Inheriting that into every worker would tell each of
 * sixteen processes it may take half the container, so the primary computes a
 * share instead and passes it on the workers' command line, where it wins over
 * the inherited option. With one worker the share is the whole allowance and
 * nothing changes from the single-process arrangement.
 *
 * @param {number} [count] workers to divide the allowance between
 * @returns {number}
 */
export function workerHeapMb(count = workerCount()) {
  const share = (memoryBudget() * HEAP_FRACTION) / count / (1024 * 1024);
  return Math.max(MIN_HEAP_MB, Math.min(MAX_HEAP_MB, Math.floor(share)));
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
 * @param {{ onExit?: (info: { pid: number | undefined, code: number, signal: string | null }) => void }} [hooks]
 * @returns {boolean} true when this process is a primary that has forked workers
 */
export function forkWorkers(hooks = {}) {
  const count = workerCount();
  if (count <= 1 || !cluster.isPrimary) return false;

  cluster.setupPrimary({
    execArgv: [...process.execArgv, `--max-old-space-size=${workerHeapMb(count)}`],
  });

  for (let i = 0; i < count; i += 1) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    hooks.onExit?.({ pid: worker.process.pid, code, signal });
    cluster.fork();
  });

  return true;
}
