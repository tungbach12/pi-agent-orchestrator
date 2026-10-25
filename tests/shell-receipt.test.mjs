import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BACKGROUND_INSTRUCTION,
  isServerCommand,
  shellCompletionEnvelope,
  shellNotice,
  shellResultText,
  truncateHeadTail,
} from '../extensions/shell-result.ts';

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

test('isServerCommand detects persistent dev servers and watchers but ignores one-shot commands', () => {
  for (const cmd of [
    'npm run dev',
    'pnpm dev',
    'yarn serve',
    'bun run watch',
    'npx vite',
    'vite --port 3000',
    'next dev',
    'python -m http.server 8000',
    'python3 manage.py runserver',
    'uvicorn app.main:app --reload',
    'tsc --watch',
    'vitest --watch',
    'docker compose up',
  ]) {
    assert.equal(isServerCommand(cmd), true, `${cmd} should be detected as a server command`);
  }

  for (const cmd of [
    'npm test',
    'npm run build',
    'npm run typecheck',
    'tsc --noEmit',
    'vitest run',
    'docker compose up -d',
    'vite --version',
    'echo hello',
  ]) {
    assert.equal(isServerCommand(cmd), false, `${cmd} should not be detected as a server command`);
  }
});

test('truncateHeadTail preserves head and tail when output exceeds maxChars', () => {
  const short = truncateHeadTail('short output', 100);
  assert.equal(short.truncated, false);
  assert.equal(short.text, 'short output');

  const input = `${'H'.repeat(60)}${'M'.repeat(100)}${'T'.repeat(60)}`;
  const res = truncateHeadTail(input, 100, { shellID: 'sh-1', file: '/tmp/sh-1.log' });
  assert.equal(res.truncated, true);
  assert.ok(res.text.startsWith('H'.repeat(40)));
  assert.ok(res.text.endsWith('T'.repeat(60)));
  assert.match(res.text, /truncated 120 chars.*sh-1/);
});

test('shellCompletionEnvelope includes structured attributes and output', () => {
  const env = shellCompletionEnvelope({
    shellID: 'sh-42',
    state: 'completed',
    command: 'npm test',
    output: '49 passing',
    exit: 0,
    file: '/tmp/sh-42.log',
  });
  assert.match(env, /^<shell shellID="sh-42" state="completed" command="npm test" exit="0" file="\/tmp\/sh-42\.log">/);
  assert.match(env, /49 passing/);
  assert.match(env, /<\/shell>$/);
});
