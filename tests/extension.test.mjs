import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';

const packageRoot = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const jiti = createJiti(pathToFileURL(join(packageRoot, 'extensions', 'index.ts')).href, {
  alias: {
    '@earendil-works/pi-coding-agent': join(packageRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
    '@earendil-works/pi-tui': join(packageRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  },
});

/** Builds a minimal ExtensionAPI and the handlers the extension registers. */
function harness() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const messages = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, options) => commands.set(name, options),
    registerMessageRenderer: () => {},
    appendEntry: () => {},
    sendMessage: (message) => messages.push(message),
  };
  return { pi, tools, commands, handlers, messages };
}

/** A tool context that only needs what the shell tool actually uses. */
function toolContext(cwd) {
  return {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => 'session-test', getSessionFile: () => undefined },
  };
}

test('the extension registers its tools and command', async () => {
  const mod = await jiti.import(join(packageRoot, 'extensions', 'index.ts'));
  const { pi, tools, commands } = harness();
  mod.default(pi);

  assert.deepEqual(
    [...tools.keys()].sort(),
    ['job_background', 'job_cancel', 'job_status', 'job_wait', 'shell', 'shell_output', 'subagent'],
  );
  assert.ok(commands.has('agents'), 'the /agents command opens the dock');
});

test('the shell tool runs a command and returns its output', async () => {
  const mod = await jiti.import(join(packageRoot, 'extensions', 'index.ts'));
  const { pi, tools } = harness();
  mod.default(pi);

  const cwd = await mkdtemp(join(tmpdir(), 'orchestrator-test-'));
  try {
    const result = await tools.get('shell').execute('call-1', { command: 'echo hello-pi' }, undefined, undefined, toolContext(cwd));
    const text = result.content[0].text;
    assert.match(text, /hello-pi/);
    assert.equal(result.details.output.status, 'completed');
    assert.equal(result.details.output.exit, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a background command reports its completion to the parent session', async () => {
  const mod = await jiti.import(join(packageRoot, 'extensions', 'index.ts'));
  const { pi, tools, messages } = harness();
  mod.default(pi);

  const cwd = await mkdtemp(join(tmpdir(), 'orchestrator-test-'));
  try {
    const result = await tools.get('shell').execute(
      'call-1',
      { command: 'echo done-in-background', background: true },
      undefined,
      undefined,
      toolContext(cwd),
    );
    assert.equal(result.details.output.status, 'running');
    // The receipt stays free of the instruction; shellResultText adds it once.
    assert.ok(!result.details.output.output.includes('Do not sleep or poll'));
    const occurrences = result.content[0].text.split('Do not sleep or poll').length - 1;
    assert.equal(occurrences, 1, 'the instruction appears exactly once');

    // The completion notice arrives on its own once the command finishes.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && messages.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(messages.length, 1, 'the parent session is notified once');
    assert.match(messages[0].content, /done-in-background/);
    assert.equal(messages[0].customType, 'agent-orchestrator-completion');
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('job_status resolves a job after its completion was delivered', async () => {
  const mod = await jiti.import(join(packageRoot, 'extensions', 'index.ts'));
  const { pi, tools, messages } = harness();
  mod.default(pi);

  const cwd = await mkdtemp(join(tmpdir(), 'orchestrator-test-'));
  try {
    const started = await tools.get('shell').execute(
      'call-1',
      { command: 'echo status-check', background: true },
      undefined,
      undefined,
      toolContext(cwd),
    );
    const shellId = started.details.shellID;

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && messages.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(messages.length, 1);

    const status = await tools.get('job_status').execute('call-2', { id: shellId });
    assert.match(status.content[0].text, /status-check|"status": "completed"/);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
