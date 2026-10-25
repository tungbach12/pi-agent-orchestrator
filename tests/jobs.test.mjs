import assert from 'node:assert/strict';
import test from 'node:test';
import { JobRegistry } from '../extensions/jobs.ts';

test('defaults to ten concurrent subagents', () => {
  assert.equal(new JobRegistry().maxConcurrentAgents, 10);
});

test('rejects a non-positive concurrency limit', () => {
  assert.throws(() => new JobRegistry(0), /maxConcurrentAgents must be a positive integer/);
  assert.throws(() => new JobRegistry(1.5), /maxConcurrentAgents must be a positive integer/);
});

test('queues subagents when the concurrency limit is full and starts them when a slot opens', async () => {
  const jobs = new JobRegistry(1);
  const starts = [];
  const finish = new Map();
  const start = (id) => jobs.start({
    id,
    type: 'subagent',
    title: id,
    started: () => starts.push(id),
    run: () => new Promise((resolve) => finish.set(id, resolve)),
  });

  start('first');
  start('second');
  start('third');
  await Promise.resolve();

  assert.deepEqual(starts, ['first']);
  assert.equal(jobs.get('second').status, 'queued');
  assert.equal(jobs.get('third').status, 'queued');

  finish.get('first')('done');
  await jobs.wait('first');
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(starts, ['first', 'second']);
  assert.equal(jobs.get('third').status, 'queued');
  finish.get('second')('done');
  await jobs.wait('second');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(starts, ['first', 'second', 'third']);
  finish.get('third')('done');
  await jobs.wait('third');
});

test('cancelling a queued subagent removes it without consuming a concurrency slot', async () => {
  const jobs = new JobRegistry(1);
  let finish;
  jobs.start({ id: 'running', type: 'subagent', title: 'running', run: () => new Promise((resolve) => { finish = resolve; }) });
  jobs.start({ id: 'queued', type: 'subagent', title: 'queued', run: async () => 'should not run' });
  await Promise.resolve();

  const cancelled = await jobs.cancel('queued');
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(jobs.get('running')?.status, 'running');
  finish('done');
  await jobs.wait('running');
});

test('shell commands run without queueing and do not consume subagent slots', async () => {
  const jobs = new JobRegistry(1);
  let finishAgent;
  jobs.start({
    id: 'agent-1',
    type: 'subagent',
    title: 'a1',
    run: () => new Promise((resolve) => { finishAgent = resolve; }),
  });
  await Promise.resolve();

  // The 1 agent slot is occupied. A shell job must start immediately!
  const shellJob = jobs.start({
    id: 'shell-1',
    type: 'shell',
    title: 's1',
    run: async () => 'shell-done',
  });
  assert.equal(shellJob.status, 'running', 'shell job runs immediately without queueing');

  const shellResult = await jobs.wait('shell-1');
  assert.equal(shellResult.info?.status, 'completed');
  assert.equal(shellResult.info?.output, 'shell-done');

  finishAgent('agent-done');
  await jobs.wait('agent-1');
});

test('foreground block returns completed output and bounded consumed history retains it', async () => {
  const jobs = new JobRegistry();
  jobs.start({ id: 'foreground', type: 'shell', title: 'echo', run: async () => 'done' });
  const result = await jobs.block('foreground', 'parent');
  assert.equal(result?.type, 'finished');
  assert.equal(result?.info.status, 'completed');
  assert.equal(result?.info.output, 'done');
  assert.equal(jobs.get('foreground')?.status, 'completed');
});

test('backgrounding unblocks the foreground waiter', async () => {
  const jobs = new JobRegistry();
  const recovery = { kind: 'shell', parentSessionId: 'parent', shellId: 'shell', command: 'long' };
  let finish;
  jobs.start({ id: 'background', type: 'shell', title: 'long', recovery, run: () => new Promise((resolve) => { finish = resolve; }) });
  await Promise.resolve();
  jobs.background('background');
  const waiter = await jobs.block('background', 'parent');
  assert.equal(waiter?.type, 'backgrounded');
  finish('done');
  const completed = await jobs.wait('background');
  assert.equal(completed.info?.output, 'done');
});

test('a backgrounded job gets a notification id when it is moved to the background', async () => {
  const jobs = new JobRegistry();
  const recovery = { kind: 'shell', parentSessionId: 'parent', shellId: 'shell', command: 'long' };
  let finish;
  jobs.start({ id: 'bg', type: 'shell', title: 'long', recovery, run: () => new Promise((resolve) => { finish = resolve; }) });
  await Promise.resolve();
  const job = jobs.background('bg');
  assert.ok(job?.notificationId, 'the job needs a notification id to report its completion');
  finish('done');
  await jobs.wait('bg');
  assert.equal(jobs.pendingBackground().length, 1);
});

test('a delivered background job stays resolvable through job_status', async () => {
  const jobs = new JobRegistry();
  const recovery = { kind: 'shell', parentSessionId: 'parent', shellId: 'shell-1', command: 'long' };
  let finish;
  jobs.start({ id: 'bg', type: 'shell', title: 'long', recovery, run: () => new Promise((resolve) => { finish = resolve; }) });
  await Promise.resolve();
  jobs.background('bg');
  const notificationId = jobs.get('bg')?.notificationId;
  assert.ok(notificationId);

  finish('done');
  const settled = await jobs.wait('bg');
  assert.equal(settled.info?.status, 'completed');
  jobs.completeBackground(notificationId);

  // The completion notice is delivered, but job_status must still resolve the job.
  assert.equal(jobs.get('bg')?.status, 'completed');
  assert.equal(jobs.get('bg')?.output, 'done');
  assert.equal(jobs.pendingBackground().length, 0);
});

test('cancel waits for the operation to stop before releasing its execution slot', async () => {
  const jobs = new JobRegistry(1);
  let stop;
  let starts = 0;
  jobs.start({
    id: 'cancel',
    type: 'subagent',
    title: 'slow',
    run: () => new Promise((resolve) => { stop = resolve; }),
    cancel: () => stop('stopped'),
  });
  jobs.start({ id: 'queued', type: 'subagent', title: 'queued', started: () => starts++, run: async () => 'done' });
  await Promise.resolve();

  const cancelling = jobs.cancel('cancel');
  await Promise.resolve();
  assert.equal(starts, 0, 'the queued job does not start while the operation is still active');
  stop('stopped');
  assert.equal((await cancelling)?.status, 'cancelled');
  await Promise.resolve();
  assert.equal(starts, 1);
  assert.equal((await jobs.wait('queued')).info?.status, 'completed');
});

test('consumed job history is persisted and restored', async () => {
  const entries = [];
  const jobs = new JobRegistry();
  jobs.bindPersistence((customType, data) => entries.push({ customType, data }), []);
  jobs.start({ id: 'persist', type: 'shell', title: 'ok', run: async () => 'ok' });
  await jobs.block('persist', 'parent');
  assert.ok(
    entries.some(
      (entry) =>
        entry.customType === 'pi-agent-orchestrator.recovery.v1' &&
        entry.data.consumed?.some((job) => job.id === 'persist'),
    ),
  );
  const restored = new JobRegistry();
  restored.bindPersistence(() => {}, entries);
  assert.equal(restored.get('persist')?.output, 'ok');
});

test('backgroundAll moves only the jobs the session is blocking', async () => {
  const jobs = new JobRegistry();
  const recovery = { kind: 'shell', parentSessionId: 'parent', shellId: 's', command: 'x' };
  jobs.start({ id: 'blocked', type: 'shell', title: 'x', recovery, run: () => new Promise(() => {}) });
  jobs.start({ id: 'free', type: 'shell', title: 'y', recovery, run: () => new Promise(() => {}) });
  await Promise.resolve();
  const blocking = jobs.block('blocked', 'parent');
  await Promise.resolve();

  const moved = jobs.backgroundAll('parent');
  assert.deepEqual(moved.map((job) => job.id), ['blocked']);
  // The job nobody waits for keeps running without a notification id.
  assert.equal(jobs.get('free')?.notificationId, undefined);
  assert.equal((await blocking)?.type, 'backgrounded');
});
