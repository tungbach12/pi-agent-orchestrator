import assert from 'node:assert/strict';
import test from 'node:test';
import { JobRegistry } from '../extensions/jobs.ts';

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

test('cancel marks a running job cancelled without waiting for the underlying operation', async () => {
  const jobs = new JobRegistry();
  jobs.start({ id: 'cancel', type: 'shell', title: 'slow', run: () => new Promise(() => {}) });
  assert.equal((await jobs.cancel('cancel'))?.status, 'cancelled');
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
