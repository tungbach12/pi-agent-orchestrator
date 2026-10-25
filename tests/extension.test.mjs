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
    sendMessage: (message, options) => messages.push({ ...message, _options: options }),
  };
  return { pi, tools, commands, handlers, messages };
}

/** A tool context that only needs what the shell tool actually uses. */
function toolContext(cwd) {
  return {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => 'session-test', getSessionFile: () => undefined },
    ui: { setStatus: () => {} },
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

test('background notification stays recoverable when sendMessage throws and retries on next session', async () => {
  const mod = await jiti.import(join(packageRoot, 'extensions', 'index.ts'));
  const { pi, tools, handlers, messages } = harness();
  const originalSend = pi.sendMessage;
  let failOnce = true;
  pi.sendMessage = (message) => {
    if (message.customType === 'agent-orchestrator-completion' && failOnce) {
      failOnce = false;
      throw new Error('session pipe unavailable');
    }
    originalSend(message);
  };
  mod.default(pi);

  const cwd = await mkdtemp(join(tmpdir(), 'orchestrator-recovery-'));
  try {
    await tools.get('shell').execute(
      'call-1',
      { command: 'echo recover-me', background: true },
      undefined,
      undefined,
      toolContext(cwd),
    );
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && failOnce) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(failOnce, false, 'the initial background send was attempted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(messages.length, 0, 'failed send is not recorded as delivered');

    const current = {
      ...toolContext(cwd),
      ui: {
        setStatus: () => {},
        getEditorComponent: () => undefined,
        setEditorComponent: () => {},
      },
      sessionManager: {
        getSessionId: () => 'session-test',
        getSessionFile: () => undefined,
        getEntries: () => [],
      },
    };
    await handlers.get('session_start')({}, current);
    assert.equal(messages.length, 1, 'the next session retries the persisted receipt');
    assert.match(messages[0].content, /recover-me/);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('the subagent schema exposes all five agent types and limits review to code and general', async () => {
  const { AGENT_EXCLUDED_TOOLS, AGENT_KINDS, SubagentParams, isCodingAgent, isReadOnlyAgent } = await import('../extensions/types.ts');
  assert.deepEqual(AGENT_KINDS, ['explore', 'code', 'review', 'research', 'general']);
  assert.deepEqual(SubagentParams.properties.agent.enum, ['explore', 'code', 'review', 'research', 'general']);
  assert.equal(SubagentParams.properties.review.type, 'boolean');
  assert.equal(SubagentParams.properties.review.required, undefined);

  for (const agent of ['explore', 'review', 'research']) {
    assert.equal(isReadOnlyAgent(agent), true, `${agent} must be read-only`);
    assert.equal(isCodingAgent(agent), false, `${agent} must not be a coding agent`);
    assert.ok(AGENT_EXCLUDED_TOOLS[agent].includes('edit'));
    assert.ok(AGENT_EXCLUDED_TOOLS[agent].includes('write'));
    assert.ok(AGENT_EXCLUDED_TOOLS[agent].includes('subagent'));
  }
  for (const agent of ['code', 'general']) {
    assert.equal(isReadOnlyAgent(agent), false, `${agent} must not be read-only`);
    assert.equal(isCodingAgent(agent), true, `${agent} must be a coding agent`);
    assert.ok(!AGENT_EXCLUDED_TOOLS[agent].includes('edit'));
    assert.ok(!AGENT_EXCLUDED_TOOLS[agent].includes('write'));
    assert.ok(AGENT_EXCLUDED_TOOLS[agent].includes('subagent'));
  }

  const { SubagentManager } = await jiti.import(join(packageRoot, 'extensions', 'subagent.ts'));
  const { JobRegistry } = await jiti.import(join(packageRoot, 'extensions', 'jobs.ts'));
  const starts = [];
  const jobs = new JobRegistry(1);
  const manager = new SubagentManager(jobs, {
    started: (child) => starts.push(child.agent),
    changed: () => {},
  });
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    isProjectTrusted: () => true,
    thinkingLevel: 'low',
    model: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: { getSessionId: () => 'parent', getSessionFile: () => undefined },
  };

  for (const role of ['explore', 'review', 'research']) {
    const result = await manager.spawn(ctx, {
      agent: role,
      description: `${role} task`,
      prompt: 'Say done.',
      review: true,
    });
    assert.equal(result.status, 'completed');
  }
  assert.deepEqual(starts, ['explore', 'review', 'research'], 'read-only agents ignore review=true; reviewer is not spawned');
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
    assert.equal(messages[0]._options?.deliverAs, 'steer', 'delivers via steer so it is not trapped in followUp queue until after final response');
    assert.equal(messages[0]._options?.triggerTurn, true);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('job_cancel suppresses duplicate background completion notification for the cancelled job', async () => {
  const mod = await jiti.import(join(packageRoot, 'extensions', 'index.ts'));
  const { pi, tools, messages } = harness();
  mod.default(pi);

  const cwd = await mkdtemp(join(tmpdir(), 'orchestrator-cancel-'));
  try {
    const started = await tools.get('shell').execute(
      'call-bg-cancel',
      { command: 'node -e "setTimeout(() => {}, 10000)"', background: true },
      undefined,
      undefined,
      toolContext(cwd),
    );
    const shellId = started.details.shellID;
    const cancelled = await tools.get('job_cancel').execute('call-cancel', { id: shellId });
    assert.match(cancelled.content[0].text, /"status": "cancelled"/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(messages.length, 0, 'explicit job_cancel must not queue a redundant completion turn');
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

    // Negative offset reads the tail of the log file.
    const tail = await tools.get('shell_output').execute('call-3', { shellID: shellId, offset: -6, limit: 6 });
    assert.ok(tail.content[0].text.length <= 6);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('background completion notices do not pollute another session and deliver when the parent session returns', async () => {
  const mod = await jiti.import(join(packageRoot, 'extensions', 'index.ts'));
  const { pi, tools, handlers, messages } = harness();
  mod.default(pi);

  const cwd = await mkdtemp(join(tmpdir(), 'orchestrator-cross-session-'));
  const sessionCtx = (id) => ({
    ...toolContext(cwd),
    ui: {
      setStatus: () => {},
      getEditorComponent: () => undefined,
      setEditorComponent: () => {},
    },
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => undefined,
      getEntries: () => [],
    },
  });

  try {
    // Switch active session to session-B before session-A's background job settles.
    await handlers.get('session_start')({}, sessionCtx('session-B'));
    await tools.get('shell').execute(
      'call-a',
      { command: 'echo from-session-a', background: true },
      undefined,
      undefined,
      { ...toolContext(cwd), sessionManager: { getSessionId: () => 'session-A', getSessionFile: () => undefined } },
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(messages.length, 0, 'session-B must not receive session-A completion notice');

    // Switching back to session-A delivers the pending receipt.
    await handlers.get('session_start')({}, sessionCtx('session-A'));
    assert.equal(messages.length, 1, 'session-A receives its deferred completion notice on return');
    assert.match(messages[0].content, /<shell .*from-session-a/s);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('subagents are hidden from /resume (SessionManager.list) and both subagents and shells restore across reload/resume', async () => {
  const { SessionManager } = await jiti.import(
    join(packageRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
  );
  const { SubagentManager } = await jiti.import(join(packageRoot, 'extensions', 'subagent.ts'));
  const { ShellManager } = await jiti.import(join(packageRoot, 'extensions', 'shell.ts'));
  const { JobRegistry } = await jiti.import(join(packageRoot, 'extensions', 'jobs.ts'));

  const cwd = await mkdtemp(join(tmpdir(), 'orchestrator-resume-'));
  const sessionDir = join(cwd, 'sessions');
  try {
    // 1. Create a persisted main session and a legacy child session sitting in the root sessionDir
    const mainSm = SessionManager.create(cwd, sessionDir);
    mainSm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Main user prompt' }], timestamp: 1000 });
    mainSm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Main reply' }], timestamp: 1100 });
    const mainFile = mainSm.getSessionFile();
    const mainId = mainSm.getSessionId();
    assert.ok(mainFile, 'main session file is persisted');

    // Simulate a legacy subagent file created directly inside sessionDir (before the subagents/ fix)
    const legacyChildSm = SessionManager.create(cwd, sessionDir, { parentSession: mainFile });
    legacyChildSm.appendCustomEntry('pi-agent-orchestrator.child', {
      agent: 'explore',
      description: 'Legacy explore child',
    });
    legacyChildSm.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'You are a subagent spawned by another session.\nFind legacy refs.' }],
      timestamp: 1200,
    });
    legacyChildSm.appendMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Searching for legacy refs.' },
        { type: 'toolCall', id: 'tc-legacy', name: 'grep', arguments: { pattern: 'legacy', path: 'src' } },
      ],
      timestamp: 1300,
    });
    legacyChildSm.appendMessage({
      role: 'toolResult',
      toolCallId: 'tc-legacy',
      toolName: 'grep',
      content: [{ type: 'text', text: 'src/legacy.ts:1: legacy' }],
      isError: false,
      timestamp: 1400,
    });
    legacyChildSm.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'Found legacy reference in src/legacy.ts:1.' }],
      timestamp: 1500,
    });
    const legacyChildId = legacyChildSm.getSessionId();

    // Before syncParentSession, SessionManager.list sees both main and legacy child (2 sessions)
    const beforeList = await SessionManager.list(cwd, sessionDir);
    assert.equal(beforeList.length, 2);

    // 2. Run syncParentSession + shell persistence as session_start does on /reload or /resume
    const customEntries = [];
    const jobs1 = new JobRegistry();
    const shells1 = new ShellManager(jobs1);
    shells1.bindPersistence((customType, data) => customEntries.push({ customType, data }), [], mainId, cwd);
    await shells1.run(
      {
        cwd,
        hasUI: false,
        sessionManager: { getSessionId: () => mainId, getSessionFile: () => mainFile },
      },
      { command: 'echo persisted-shell' },
    );

    // Simulate a fresh manager instance after /resume or Pi restart
    const jobs2 = new JobRegistry();
    const shells2 = new ShellManager(jobs2);
    const subagents2 = new SubagentManager(jobs2);
    shells2.bindPersistence(() => {}, customEntries, mainId, cwd);
    subagents2.bindPersistence(() => {}, customEntries, mainId);
    await subagents2.syncParentSession({
      cwd,
      sessionManager: { getSessionId: () => mainId, getSessionFile: () => mainFile },
    });

    // After syncParentSession:
    // (a) SessionManager.list (/resume) only shows the main session (1 session), NOT the subagent!
    const afterList = await SessionManager.list(cwd, sessionDir);
    assert.deepEqual(
      afterList.map((s) => s.id),
      [mainId],
      '/resume list must contain only main sessions, never subagents',
    );

    // (b) subagents2.list(mainId) restores the child session with its prompt, thinking, tools, and result for Ctrl+A
    const restoredChildren = subagents2.list(mainId);
    assert.equal(restoredChildren.length, 1);
    assert.equal(restoredChildren[0].sessionId, legacyChildId);
    assert.equal(restoredChildren[0].description, 'Legacy explore child');
    assert.equal(restoredChildren[0].lastPrompt, 'Find legacy refs.');
    assert.equal(restoredChildren[0].thinking, 'Searching for legacy refs.');
    assert.equal(restoredChildren[0].tools.length, 1);
    assert.equal(restoredChildren[0].tools[0].name, 'grep');
    assert.equal(restoredChildren[0].result, 'Found legacy reference in src/legacy.ts:1.');

    // (c) shells2.list(mainId) restores the completed shell command for Ctrl+A
    const restoredShells = shells2.list(mainId);
    assert.equal(restoredShells.length, 1);
    assert.equal(restoredShells[0].command, 'echo persisted-shell');
    assert.equal(restoredShells[0].status, 'completed');
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
