import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BACKGROUND_INSTRUCTION, shellNotice, shellResultText } from '../extensions/shell-result.ts';
import { EXPLORE_PROMPT, EXPLORE_PROMPT_UPSTREAM, GENERAL_PROMPT, SUBAGENT_NO_TEXT, subagentResultEnvelope } from '../extensions/prompts.ts';

/**
 * These checks compare prompt text and result formatting against the OpenCode sources this package
 * started from, so they need a local clone. Point OPENCODE_UPSTREAM at it, or place one of the usual
 * sibling directories; without a clone they are skipped rather than failed, which keeps `npm test`
 * green on a machine that has no reference checkout.
 */
const CANDIDATES = [process.env.OPENCODE_UPSTREAM, '../opencode', '../../opencode'].filter(Boolean);
const UPSTREAM = CANDIDATES.map((candidate) => resolve(candidate)).find((candidate) => existsSync(`${candidate}/packages/core/src/tool/plugin/shell.ts`));
const skip = UPSTREAM ? false : `No OpenCode clone found (tried ${CANDIDATES.join(', ')}); set OPENCODE_UPSTREAM to run parity tests.`;

/** Read an upstream file with line endings normalized, since the clone is checked out with CRLF here. */
function read(file) {
  return readFileSync(`${UPSTREAM}/${file}`, 'utf8').replace(/\r\n/g, '\n');
}

test('background instruction matches the reference text', { skip }, () => {
  // Upstream is formatted without semicolons, so terminate at the closing quote and newline.
  const match = read('packages/core/src/tool/plugin/shell.ts').match(/const BACKGROUND_INSTRUCTION =\n {2}"([\s\S]*?)"\n/);
  assert.ok(match, 'could not locate BACKGROUND_INSTRUCTION upstream');
  assert.equal(BACKGROUND_INSTRUCTION, match[1]);
});

test('shell notices match the reference wording', { skip }, () => {
  const source = read('packages/core/src/shell/result.ts');
  assert.match(source, /Timed out before completion/);
  assert.match(source, /Killed by \$\{output.signal\}/);
  assert.match(source, /Exited with code \$\{output.exit\}/);

  assert.equal(shellNotice({ timeout: true }), 'Timed out before completion');
  assert.equal(shellNotice({ signal: 'SIGKILL' }), 'Killed by SIGKILL');
  assert.equal(shellNotice({ exit: 3 }), 'Exited with code 3');
  // A zero exit is successful, so OpenCode emits no notice at all.
  assert.equal(shellNotice({ exit: 0 }), undefined);
  assert.equal(shellNotice({}), undefined);
});

test('shell result text appends the notice as a separate paragraph', { skip }, () => {
  assert.equal(shellResultText({ output: 'hi', exit: 0 }), 'hi');
  assert.equal(shellResultText({ output: 'hi', exit: 2 }), 'hi\n\nExited with code 2');
  assert.equal(shellResultText({ output: '', exit: 2 }), 'Exited with code 2');
  assert.equal(shellResultText({ output: '', status: 'running' }), BACKGROUND_INSTRUCTION);
  assert.equal(shellResultText({ output: 'stream', status: 'running' }), `stream\n\n${BACKGROUND_INSTRUCTION}`);
});

test('explore prompt keeps the reference text verbatim before the Pi tool mapping', { skip }, () => {
  const match = read('packages/core/src/plugin/agent.ts').match(/const PROMPT_EXPLORE = `([\s\S]*?)`/);
  assert.ok(match, 'could not locate PROMPT_EXPLORE upstream');
  assert.equal(EXPLORE_PROMPT_UPSTREAM, match[1]);
  assert.ok(EXPLORE_PROMPT.startsWith(EXPLORE_PROMPT_UPSTREAM));
  assert.match(EXPLORE_PROMPT.slice(EXPLORE_PROMPT_UPSTREAM.length), /<pi_tool_mapping>/);
});

test('general agent has no overridden system prompt, matching the reference', { skip }, () => {
  const source = read('packages/core/src/plugin/agent.ts');
  const start = source.indexOf('Agent.ID.make("general")');
  assert.ok(start !== -1, 'could not locate the general agent definition upstream');
  const body = source.slice(start, source.indexOf('editor.update(', start + 10));
  assert.doesNotMatch(body, /item\.system/, 'upstream general agent must not set a system prompt');
  assert.equal(GENERAL_PROMPT, undefined);
});

test('subagent completion envelope matches the reference tool content', { skip }, () => {
  assert.match(read('packages/core/src/tool/plugin/subagent.ts'), /state="completed"/);
  assert.equal(subagentResultEnvelope('ses_1', 'done'), '<subagent sessionID="ses_1" state="completed">\ndone\n</subagent>');
  assert.equal(SUBAGENT_NO_TEXT, 'Subagent completed without a text response.');
  assert.match(read('packages/core/src/session/subagent-completion.ts'), /Subagent completed without a text response\./);
});
