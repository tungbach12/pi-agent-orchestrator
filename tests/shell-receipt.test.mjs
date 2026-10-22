import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_INSTRUCTION, shellNotice, shellResultText } from '../extensions/shell-result.ts';

const packageRoot = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

test('the background receipt does not repeat the background instruction', () => {
  const source = readFileSync(join(packageRoot, 'extensions', 'shell.ts'), 'utf8');
  const receipts = [
    ...source.matchAll(/output: `Command moved to the background[\s\S]*?`,/g),
  ].map((match) => match[0]);

  assert.equal(receipts.length, 2, 'both background paths return a receipt');
  for (const receipt of receipts) {
    assert.ok(!receipt.includes('BACKGROUND_INSTRUCTION'), 'the receipt must not embed BACKGROUND_INSTRUCTION');
  }
});

test('shellResultText appends the background instruction exactly once', () => {
  const text = shellResultText({ output: 'Command moved to the background.', status: 'running' });
  const occurrences = text.split(BACKGROUND_INSTRUCTION).length - 1;
  assert.equal(occurrences, 1);
});

test('shellResultText reports the exit code as a separate paragraph', () => {
  assert.equal(shellResultText({ output: 'hi', exit: 0 }), 'hi');
  assert.equal(shellResultText({ output: 'hi', exit: 2 }), 'hi\n\nExited with code 2');
  assert.equal(shellResultText({ output: '', exit: 2 }), 'Exited with code 2');
  assert.equal(shellResultText({ output: 'stream', status: 'running' }), `stream\n\n${BACKGROUND_INSTRUCTION}`);
});

test('a successful command reports no notice at all', () => {
  assert.equal(shellNotice({ exit: 0 }), undefined);
  assert.equal(shellNotice({}), undefined);
  assert.equal(shellNotice({ timeout: true }), 'Timed out before completion');
  assert.equal(shellNotice({ signal: 'SIGKILL' }), 'Killed by SIGKILL');
});
