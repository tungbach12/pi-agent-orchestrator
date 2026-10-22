import assert from 'node:assert/strict';
import test from 'node:test';
import { isReadOnlyCommand } from '../extensions/read-only.ts';

test('plain read commands are allowed', () => {
  for (const command of [
    'ls',
    'ls -la',
    'cat README.md',
    'head -20 package.json',
    'grep -r TODO src/',
    'find . -name "*.ts"',
    'git status',
    'git log --oneline -10',
    'git diff HEAD~1',
    'npm ls',
    'wc -l main.ts',
    'pwd',
  ]) {
    assert.equal(isReadOnlyCommand(command).allowed, true, `${command} should be allowed`);
  }
});

test('commands that write are blocked', () => {
  for (const command of [
    'rm file.txt',
    'rm -rf build',
    'mv a b',
    'cp a b',
    'mkdir new',
    'touch new.txt',
    'chmod +x script.sh',
    'git commit -m "x"',
    'git add .',
    'git push',
    'npm install',
    'curl https://example.com',
    'echo hi > out.txt',
    'echo hi >> out.txt',
  ]) {
    assert.equal(isReadOnlyCommand(command).allowed, false, `${command} should be blocked`);
  }
});

test('a write hidden behind a chain is blocked', () => {
  assert.equal(isReadOnlyCommand('ls && rm file').allowed, false);
  assert.equal(isReadOnlyCommand('ls; rm file').allowed, false);
  assert.equal(isReadOnlyCommand('ls | tee out.txt').allowed, false);
  assert.equal(isReadOnlyCommand('cat $(rm file)').allowed, false);
});

test('a pipe between two reads is allowed', () => {
  assert.equal(isReadOnlyCommand('grep -r TODO src/ | head -20').allowed, true);
  assert.equal(isReadOnlyCommand('find . -name "*.ts" | wc -l').allowed, true);
});

test('an unknown command is blocked', () => {
  const verdict = isReadOnlyCommand('some-unknown-tool --flag');
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /not a known read-only command/);
});

test('an empty command is blocked', () => {
  assert.equal(isReadOnlyCommand('   ').allowed, false);
});
