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

test('backgrounding unblocks foreground waiter and delivers one recoverable completion', async () => {
  const jobs = new JobRegistry();
  let finish;
  const recovery = { kind: 'shell', parentSessionId: 'parent', shellId: 'shell', command: 'long' };
  jobs.start({ id: 'background', type: 'shell', title: 'long', recovery, run: () => new Promise((resolve) => { finish = resolve; }) });
  const waiter = jobs.block('background', 'parent');
  await Promise.resolve();
  jobs.background('background');
  assert.equal((await waiter)?.type, 'backgrounded');
  finish('done');
  const completed = await jobs.wait('background');
  assert.equal(completed.info?.output, 'done');
  assert.equal(jobs.pendingBackground().length, 1);
  jobs.completeBackground(completed.info.notificationId);
  assert.equal(jobs.pendingBackground().length, 0);
});

test('cancel marks a running job cancelled without waiting for the underlying operation', async () => {
  const jobs = new JobRegistry();
  jobs.start({ id: 'cancel', type: 'shell', title: 'slow', run: () => new Promise(() => {}) });
  assert.equal((await jobs.cancel('cancel'))?.status, 'cancelled');
});

test('consumed foreground job history is persisted and restored', async () => {
  const entries = [];
  const jobs = new JobRegistry();
  jobs.bindPersistence((customType, data) => entries.push({ customType, data }), []);
  jobs.start({ id: 'persist', type: 'shell', title: 'ok', run: async () => 'ok' });
  await jobs.block('persist', 'parent');
  assert.ok(entries.some((entry) => entry.customType === 'pi-agent-orchestrator.recovery.v1' && entry.data.consumed?.some((job) => job.id === 'persist')));
  const restored = new JobRegistry();
  restored.bindPersistence(() => {}, entries);
  assert.equal(restored.get('persist')?.output, 'ok');
});
