import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadOnlyGuard, defaultPlanRelativePath, isAllowedPlanPath } from '../extensions/read-only.ts';

test('read-only guard blocks write and edit while leaving bash and read tools unrestricted', () => {
  let handler;
  createReadOnlyGuard({ cwd: process.cwd() })({
    on: (_event, fn) => { handler = fn; },
  });

  assert.equal(handler({ toolName: 'write', input: { path: 'src/app.ts' } })?.block, true);
  assert.equal(handler({ toolName: 'edit', input: { path: 'README.md' } })?.block, true);
  assert.equal(handler({ toolName: 'bash', input: { command: 'cd repo && git status --short' } }), undefined);
  assert.equal(handler({ toolName: 'bash', input: { command: 'git -C repo log -n 5' } }), undefined);
  assert.equal(handler({ toolName: 'bash', input: { command: 'find repo -type f -printf "%P|%s|%T@\\n"' } }), undefined);
  assert.equal(handler({ toolName: 'read', input: { path: 'README.md' } }), undefined);
  assert.equal(handler({ toolName: 'grep', input: { pattern: 'foo|bar' } }), undefined);
});

test('plan path guard allows only .md files inside .pi/plans/ and blocks all other paths', () => {
  const cwd = process.cwd();
  assert.equal(defaultPlanRelativePath('Add Auth Flow!'), '.pi/plans/add-auth-flow.md');

  for (const valid of [
    '.pi/plans/add-auth-flow.md',
    '.pi/plans/sub/feature.md',
  ]) {
    assert.equal(isAllowedPlanPath(cwd, valid).allowed, true, `${valid} should be allowed`);
  }

  for (const invalid of [
    'src/index.ts',
    'README.md',
    '.pi/plans/script.sh',
    '.pi/plans/../secret.md',
    '../outside.md',
    '   ',
  ]) {
    assert.equal(isAllowedPlanPath(cwd, invalid).allowed, false, `${invalid} should be blocked`);
  }

  let handler;
  createReadOnlyGuard({ cwd, allowPlanFiles: true })({
    on: (_event, fn) => { handler = fn; },
  });
  assert.equal(handler({ toolName: 'write', input: { path: '.pi/plans/my-plan.md' } }), undefined);
  assert.equal(handler({ toolName: 'edit', input: { path: '.pi/plans/my-plan.md' } }), undefined);
  assert.equal(handler({ toolName: 'write', input: { path: 'src/app.ts' } })?.block, true);
  assert.equal(handler({ toolName: 'edit', input: { path: 'README.md' } })?.block, true);
});
