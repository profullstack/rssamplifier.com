import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { cpuBudget, memoryBudget, share, workerCount, workerHeapMb } from '../src/lib/workers.js';

/**
 * The worker pool's arithmetic.
 *
 * What it must get right is that every number stays inside what the *container*
 * has. Reading the host's CPUs would fork twice as many workers as this machine
 * can run; reading the host's memory would hand each of them a heap ceiling
 * forty times the container's limit, and the platform would kill it. Neither
 * mistake announces itself — the site comes up and is simply worse — so the
 * budgets are asserted against the cgroup values wherever there is a cgroup to
 * read, and the shares are asserted for the cases that round badly.
 */

test.beforeEach(() => {
  delete process.env.WEB_WORKERS;
});

test.after(() => {
  delete process.env.WEB_WORKERS;
});

test('the CPU budget is a whole number of usable CPUs', () => {
  const cpus = cpuBudget();
  assert.ok(Number.isInteger(cpus), 'a fractional worker cannot be forked');
  assert.ok(cpus >= 1, 'there is always at least one CPU to run on');
  assert.ok(cpus <= os.availableParallelism(), 'a quota cannot exceed the machine it is on');
});

test('the memory budget never exceeds the machine', () => {
  const bytes = memoryBudget();
  assert.ok(bytes > 0);
  assert.ok(bytes <= os.totalmem(), 'a container limit above the host total is the no-limit sentinel');
});

test('WEB_WORKERS decides the count, and 1 is the way back to one process', () => {
  process.env.WEB_WORKERS = '4';
  assert.equal(workerCount(), 4);

  process.env.WEB_WORKERS = '1';
  assert.equal(workerCount(), 1);
});

test('the count is capped however many CPUs the machine offers', () => {
  process.env.WEB_WORKERS = '512';
  assert.ok(workerCount() <= 16, 'a worker costs a whole Next server; the return falls off');
});

test('junk in WEB_WORKERS falls back to the CPU budget, never to zero', () => {
  for (const junk of ['', 'lots', '0', '-4', '2.5', 'NaN']) {
    process.env.WEB_WORKERS = junk;
    const count = workerCount();
    assert.ok(count >= 1, `${JSON.stringify(junk)} does not leave the site with no servers`);
    assert.equal(count, Math.max(1, Math.min(cpuBudget(), 16)));
  }
});

test('a worker heap is a share of the container, not of the host', () => {
  const one = workerHeapMb(1);
  const sixteen = workerHeapMb(16);

  assert.ok(sixteen <= one, 'more workers means less heap each');
  assert.ok(one <= 12_288, 'never more than V8 would have taken on its own');
  assert.ok(sixteen >= 512, 'never so little that a single render cannot finish');

  const containerMb = memoryBudget() / (1024 * 1024);
  assert.ok(one <= containerMb, 'one worker may not be promised more than the container has');
});

test('a share divides a service-wide allowance and never rounds to zero', () => {
  assert.equal(share(128, 16), 8);
  assert.equal(share(128, 1), 128);
  assert.equal(share(4, 16), 1, 'a worker allowed nothing would refuse everything');
  assert.equal(share(1, 16), 1);
});
