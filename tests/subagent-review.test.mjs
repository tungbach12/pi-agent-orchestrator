import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';

const packageRoot = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const jiti = createJiti(pathToFileURL(join(packageRoot, 'extensions', 'subagent.ts')).href, {
  alias: {
    '@earendil-works/pi-coding-agent': join(packageRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
    '@earendil-works/pi-tui': join(packageRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  },
});
const { SubagentManager } = await jiti.import(join(packageRoot, 'extensions', 'subagent.ts'));
const { JobRegistry } = await jiti.import(join(packageRoot, 'extensions', 'jobs.ts'));
const { buildExecutionTelemetry, formatSubagentPrompt, subagentResultEnvelope } = await jiti.import(
  join(packageRoot, 'extensions', 'prompts.ts'),
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeSession({ output, toolName = 'bash', command = 'npm test', exitCode = 0, sessionId }) {
  const events = new Set();
  const call = deferred();
  const manager = {
    getSessionId: () => sessionId,
    getSessionFile: () => undefined,
    appendCustomEntry: () => {},
  };
  const session = {
    sessionId,
    sessionManager: manager,
    model: undefined,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: output }] }],
    getLastAssistantText: () => output,
    setActiveToolsByName: () => {},
    setModel: async () => {},
    prompt: async (prompt) => {
      if (toolName) {
        for (const fn of events) fn({
          type: 'tool_execution_start', toolName, args: { command },
        });
        for (const fn of events) fn({
          type: 'tool_execution_end', toolName, args: { command }, isError: exitCode !== 0,
          result: {
            content: [{ type: 'text', text: exitCode === 0 ? 'BUILD SUCCESS' : 'BUILD FAILED' }],
            structuredContent: toolName === 'bash' ? { exit_code: exitCode, output: exitCode === 0 ? 'BUILD SUCCESS' : 'BUILD FAILED' } : undefined,
          },
        });
      }
      call.resolve(prompt);
    },
    subscribe: (fn) => { events.add(fn); return () => events.delete(fn); },
    abort: async () => {},
    dispose: () => {},
  };
  return { session, call };
}

function makeContext() {
  const created = [];
  let next = 0;
  const model = { provider: 'test', id: 'model' };
  const registry = {
    find: () => model,
    getAll: () => [],
  };
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    thinkingLevel: 'low',
    model,
    modelRegistry: registry,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => 'parent-session',
      getSessionFile: () => 'parent-session.jsonl',
    },
  };
  const createAgentSession = async ({ sessionManager, tools, excludeTools, customTools, resourceLoader, thinkingLevel }) => {
    const id = `child-${++next}`;
      const isReviewer = tools.includes('bash') && !tools.includes('edit');
      const output = isReviewer
        ? 'VERDICT: PASS\nFINDINGS:\n- NONE'
        : 'Implemented the requested task.';
      const fake = makeSession({
        output,
        toolName: isReviewer ? 'git' : createAgentSession.implementerTool ?? 'bash',
        command: isReviewer ? 'git diff -- README.md' : 'npm test',
        sessionId: id,
      });
      // Use the real session manager supplied by the package, but expose the
      // review request prompt for assertions without calling an LLM.
      fake.session.sessionManager = sessionManager;
      created.push({
        id,
        tools,
        excludeTools: excludeTools ?? [],
        customTools: customTools ?? [],
        thinkingLevel,
        systemPrompt: resourceLoader?.getSystemPrompt?.(),
        session: fake.session,
        call: fake.call,
        isReviewer,
      });
    return { session: fake.session, sessionId: id };
  };
  return { ctx, created, createAgentSession };
}

test('review=true spawns an explore-only reviewer and returns its PASS with test evidence', async () => {
  const { ctx, created, createAgentSession } = makeContext();
  const jobs = new JobRegistry();
  const manager = new SubagentManager(jobs, { changed: () => {} }, createAgentSession);
  const result = await manager.spawn(ctx, {
    agent: 'general',
    description: 'review me',
    prompt: 'Implement feature X. Acceptance: add X and make tests pass.',
    review: true,
  });

  assert.equal(result.status, 'completed');
  assert.match(result.output, /Implementation verified against the task by an independent reviewer/);
  assert.equal(created.length, 2);
  assert.ok(created[1].tools.includes('bash'));
  assert.ok(!created[1].tools.includes('edit'));
  assert.ok(!created[1].tools.includes('write'));
  assert.equal(
    created[0].session.sessionManager.getHeader().parentSession,
    created[1].session.sessionManager.getHeader().parentSession,
    'implementer and reviewer are isolated sibling sessions under the original parent',
  );
});

test('review defaults off and explore agents never spawn a reviewer', async () => {
  const { ctx, created, createAgentSession } = makeContext();
  const jobs = new JobRegistry();
  const manager = new SubagentManager(jobs, { changed: () => {} }, createAgentSession);
  const result = await manager.spawn(ctx, {
    agent: 'explore',
    description: 'explore only',
    prompt: 'Find the relevant files.',
  });
  assert.equal(result.status, 'completed');
  assert.equal(created.length, 1);
});

test('review PASS without captured successful checks must fail closed', async () => {
  const { ctx, created, createAgentSession } = makeContext();
  createAgentSession.implementerTool = 'read';
  const jobs = new JobRegistry();
  const manager = new SubagentManager(jobs, { changed: () => {} }, createAgentSession);
  await assert.rejects(
    manager.spawn(ctx, {
      agent: 'general', description: 'missing evidence',
      prompt: 'Change code and run npm test.', review: true,
    }),
    /not verified|not reviewed|uncertain/i,
  );
});

test('code agent gets full coding tools, custom system prompt, and supports review=true', async () => {
  const { ctx, created, createAgentSession } = makeContext();
  const jobs = new JobRegistry();
  const manager = new SubagentManager(jobs, { changed: () => {} }, createAgentSession);
  const result = await manager.spawn(ctx, {
    agent: 'code',
    description: 'implement feature',
    prompt: 'Implement feature Y and pass npm test.',
    review: true,
  });

  assert.equal(result.status, 'completed');
  assert.match(result.output, /Implementation verified against the task by an independent reviewer/);
  assert.equal(created.length, 2);
  assert.deepEqual(created[0].tools, ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'codemode']);
  assert.match(created[0].systemPrompt ?? '', /software engineering and implementation specialist/i);
  assert.deepEqual(created[1].tools, ['read', 'grep', 'find', 'ls', 'bash', 'codemode']);
});

test('subagents inherit all parent tools and apply role-based exclusions', async () => {
  const { ctx, created, createAgentSession } = makeContext();
  ctx.tools = [
    { name: 'web_search', label: 'Web Search', description: 'Search the web', parameters: {}, execute: async () => ({ content: [] }) },
    { name: 'fetch_content', label: 'Fetch Content', description: 'Fetch URL', parameters: {}, execute: async () => ({ content: [] }) },
    { name: 'mcp__docs__search', label: 'Docs Search', description: 'Search docs', parameters: {}, execute: async () => ({ content: [] }) },
    { name: 'mutating_ext_tool', label: 'Mutating', description: 'Writes state', parameters: {}, annotations: { destructiveHint: true }, execute: async () => ({ content: [] }) },
    { name: 'subagent', label: 'Subagent', description: 'Must be excluded', parameters: {}, execute: async () => ({ content: [] }) },
    { name: 'ask_user_question', label: 'Ask User', description: 'Must be excluded', parameters: {}, execute: async () => ({ content: [] }) },
  ];
  const jobs = new JobRegistry();
  const manager = new SubagentManager(jobs, { changed: () => {} }, createAgentSession);

  await manager.spawn(ctx, { agent: 'research', description: 'research topic', prompt: 'Investigate X.' });
  await manager.spawn(ctx, { agent: 'explore', description: 'explore files', prompt: 'Find Y.' });
  await manager.spawn(ctx, { agent: 'review', description: 'review diff', prompt: 'Review Z.' });
  await manager.spawn(ctx, { agent: 'general', description: 'general work', prompt: 'Do W.' });

  assert.equal(created.length, 4);

  // research (read-only: inherits read-only parent tools, excludes edit/write/subagent/ask_user_question and destructive parent tools)
  assert.deepEqual(created[0].tools, [
    'read', 'grep', 'find', 'ls', 'bash', 'codemode',
    'web_search', 'fetch_content', 'mcp__docs__search',
  ]);
  assert.ok(created[0].excludeTools.includes('edit'));
  assert.ok(created[0].excludeTools.includes('write'));
  assert.ok(created[0].excludeTools.includes('subagent'));
  assert.match(created[0].systemPrompt ?? '', /deep research specialist/i);

  // explore (read-only)
  assert.deepEqual(created[1].tools, [
    'read', 'grep', 'find', 'ls', 'bash', 'codemode',
    'web_search', 'fetch_content', 'mcp__docs__search',
  ]);
  assert.match(created[1].systemPrompt ?? '', /file search specialist/i);

  // review (read-only)
  assert.deepEqual(created[2].tools, [
    'read', 'grep', 'find', 'ls', 'bash', 'codemode',
    'web_search', 'fetch_content', 'mcp__docs__search',
  ]);
  assert.match(created[2].systemPrompt ?? '', /senior code and diff reviewer/i);

  // general (coding/full-access: inherits all non-orchestrator parent tools including mutating_ext_tool, keeps edit/write)
  assert.deepEqual(created[3].tools, [
    'read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'codemode',
    'web_search', 'fetch_content', 'mcp__docs__search', 'mutating_ext_tool',
  ]);
  assert.ok(!created[3].excludeTools.includes('edit'));
  assert.ok(!created[3].excludeTools.includes('write'));
  assert.ok(created[3].excludeTools.includes('subagent'));
  assert.equal(created[3].systemPrompt, undefined);
  for (const child of created) {
    assert.equal(child.thinkingLevel, ctx.thinkingLevel, 'child inherits thinkingLevel from parent session');
  }
});

test('expectedOutput contract is appended to the child prompt and telemetry reports ground-truth tool activity', async () => {
  const promptText = formatSubagentPrompt({
    prompt: 'Inspect auth module.',
    expectedOutput: '1. Entry points with file:line\n2. Token expiry handling',
    fresh: true,
  });
  assert.match(promptText, /REQUIRED OUTPUT CONTRACT/);
  assert.match(promptText, /1\. Entry points with file:line/);

  // Case 1: File modified and verified after edit
  const verifiedTelemetry = buildExecutionTelemetry([
    { name: 'read', input: { path: 'src/auth.ts' }, startedAt: 1, completedAt: 2, status: 'completed' },
    { name: 'edit', input: { path: 'src/auth.ts' }, startedAt: 3, completedAt: 4, status: 'completed' },
    { name: 'bash', input: { command: 'npm test' }, startedAt: 5, completedAt: 6, status: 'completed', exitCode: 0, output: '10 passing' },
  ]);
  assert.match(verifiedTelemetry, /Tools: 3 calls \(1 read, 1 edit, 1 bash\)/);
  assert.match(verifiedTelemetry, /Files modified: src\/auth\.ts/);
  assert.match(verifiedTelemetry, /Commands: `npm test` \(exit 0\)/);
  assert.match(verifiedTelemetry, /Verification: PASS/);

  // Case 2: File modified WITHOUT running verification after edit
  const unverifiedTelemetry = buildExecutionTelemetry([
    { name: 'bash', input: { command: 'npm test' }, startedAt: 1, completedAt: 2, status: 'completed', exitCode: 0, output: '10 passing' },
    { name: 'edit', input: { path: 'src/auth.ts' }, startedAt: 3, completedAt: 4, status: 'completed' },
  ]);
  assert.match(unverifiedTelemetry, /Files modified: src\/auth\.ts/);
  assert.match(unverifiedTelemetry, /Verification: UNVERIFIED/);

  const envelope = subagentResultEnvelope('s-1', 'Summary text', {
    agent: 'code',
    description: 'fix auth',
    tools: [{ name: 'edit', input: { path: 'src/auth.ts' }, startedAt: 1, completedAt: 2, status: 'completed' }],
  });
  assert.match(envelope, /<telemetry>[\s\S]*Files modified: src\/auth\.ts[\s\S]*Verification: UNVERIFIED[\s\S]*<\/telemetry>/);
});

test('one-shot empty completion nudge recovers when a subagent executes tools but returns no text on first turn', async () => {
  const { ctx } = makeContext();
  let promptCalls = 0;
  const createEmptyThenAnswerSession = async ({ sessionManager }) => {
    const events = new Set();
    const session = {
      sessionId: 'child-nudge',
      sessionManager,
      model: undefined,
      messages: [],
      getLastAssistantText: () => (promptCalls >= 2 ? 'Synthesized report after nudge.' : ''),
      setActiveToolsByName: () => {},
      setModel: async () => {},
      prompt: async () => {
        promptCalls++;
        if (promptCalls === 1) {
          for (const fn of events) {
            fn({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'grep', args: { pattern: 'foo' } });
            fn({
              type: 'tool_execution_end',
              toolCallId: 'tc-1',
              toolName: 'grep',
              args: { pattern: 'foo' },
              isError: false,
              result: { content: [{ type: 'text', text: 'src/a.ts:1: foo' }] },
            });
          }
          session.messages = [{ role: 'assistant', content: [] }];
        } else {
          session.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Synthesized report after nudge.' }] }];
        }
      },
      subscribe: (fn) => {
        events.add(fn);
        return () => events.delete(fn);
      },
      abort: async () => {},
      dispose: () => {},
    };
    return { session, sessionId: 'child-nudge' };
  };

  const jobs = new JobRegistry();
  const manager = new SubagentManager(jobs, { changed: () => {} }, createEmptyThenAnswerSession);
  const res = await manager.spawn(ctx, {
    agent: 'explore',
    description: 'test nudge',
    prompt: 'Find foo.',
  });
  assert.equal(promptCalls, 2, 'nudges exactly once when tools ran but first turn had no text');
  assert.equal(res.output, 'Synthesized report after nudge.');
  assert.equal(res.tools.length, 1);
});

test('pressing Esc stops a running subagent immediately without firing nudge, and continue resumes the same sessionID', async () => {
  const { ctx } = makeContext();
  const promptsReceived = [];
  let releaseFirstPrompt;
  const firstPromptStarted = deferred();

  const createAbortableSession = async ({ sessionManager }) => {
    const events = new Set();
    const session = {
      sessionId: 'child-esc-resume',
      sessionManager,
      model: undefined,
      messages: [],
      getLastAssistantText: () => '',
      setActiveToolsByName: () => {},
      setModel: async () => {},
      prompt: async (promptText) => {
        promptsReceived.push(promptText);
        if (promptsReceived.length === 1) {
          for (const fn of events) {
            fn({ type: 'tool_execution_start', toolCallId: 'tc-read-1', toolName: 'read', args: { path: 'src/db.sql' } });
            fn({
              type: 'tool_execution_end',
              toolCallId: 'tc-read-1',
              toolName: 'read',
              args: { path: 'src/db.sql' },
              isError: false,
              result: { content: [{ type: 'text', text: 'CREATE TABLE t;' }] },
            });
          }
          firstPromptStarted.resolve();
          await new Promise((resolve) => {
            releaseFirstPrompt = resolve;
          });
          session.messages.push({
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'This operation was aborted',
          });
        } else {
          session.messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'Completed DB migration analysis after resume.' }],
            stopReason: 'stop',
          });
        }
      },
      subscribe: (fn) => {
        events.add(fn);
        return () => events.delete(fn);
      },
      abort: async () => {
        releaseFirstPrompt?.();
      },
      dispose: () => {},
    };
    return { session, sessionId: 'child-esc-resume' };
  };

  const jobs = new JobRegistry();
  const manager = new SubagentManager(jobs, { changed: () => {} }, createAbortableSession);
  const customEntries = [];
  manager.bindPersistence((customType, data) => customEntries.push({ customType, data }), [], 'parent-session');
  const escController = new AbortController();

  const firstRunPromise = manager.spawn(
    ctx,
    {
      agent: 'explore',
      description: 'Check Backend DB tests & migrations',
      prompt: 'Inspect V1 and V2 migrations.',
      expectedOutput: '1. Migration tracking status\n2. Schema tests',
    },
    escController.signal,
  );

  await firstPromptStarted.promise;
  assert.equal(manager.hasActiveForParent('parent-session'), true);

  // User presses Esc in Main TUI
  escController.abort();
  const cancelledResult = await firstRunPromise;

  assert.equal(promptsReceived.length, 1, 'must NOT fire EMPTY_COMPLETION_NUDGE when aborted via Esc');
  assert.equal(cancelledResult.status, 'cancelled');
  assert.equal(cancelledResult.sessionId, 'child-esc-resume');
  assert.equal(cancelledResult.tools.length, 1);
  assert.match(cancelledResult.output, /sessionID="child-esc-resume"/);

  // Simulate /reload (which calls bindPersistence on the singleton SubagentManager while sessions Map still has the session)
  manager.bindPersistence((customType, data) => customEntries.push({ customType, data }), customEntries, 'parent-session');

  // Parent turn start consumes interrupted subagent notice once
  const interrupted = manager.consumeInterruptedForParent('parent-session');
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].sessionId, 'child-esc-resume');
  assert.equal(manager.consumeInterruptedForParent('parent-session').length, 0);

  // User sends "continue" -> Parent resumes the stopped subagent via sessionID (must NOT throw "Child session must be resumed before running")
  const resumedResult = await manager.spawn(ctx, {
    agent: 'explore',
    sessionID: cancelledResult.sessionId,
    description: 'Check Backend DB tests & migrations',
    prompt: 'Continue from where you left off and finish the report.',
  });

  assert.equal(resumedResult.status, 'completed');
  assert.equal(resumedResult.sessionId, 'child-esc-resume');
  assert.match(resumedResult.output, /Completed DB migration analysis after resume/);
  assert.equal(resumedResult.tools.length, 1, 'preserves tools from interrupted run in telemetry');
  assert.match(promptsReceived[1], /REQUIRED OUTPUT CONTRACT/, 'preserves expectedOutput contract across resume');
});

test('sending a message while a foreground subagent runs auto-backgrounds it, and calling subagent with its sessionID steers the running session', async () => {
  const { ctx } = makeContext();
  const steeredMessages = [];
  let releaseInitialRun;
  const initialRunStarted = deferred();

  const createSteerableSession = async ({ sessionManager }) => {
    const events = new Set();
    const session = {
      sessionId: 'child-steerable',
      sessionManager,
      model: undefined,
      messages: [],
      getLastAssistantText: () => '',
      setActiveToolsByName: () => {},
      setModel: async () => {},
      steer: async (text) => {
        steeredMessages.push(text);
        releaseInitialRun?.();
      },
      prompt: async () => {
        initialRunStarted.resolve();
        await new Promise((resolve) => {
          releaseInitialRun = resolve;
        });
        session.messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: `Finished initial task plus steered instructions (${steeredMessages.length}).` }],
          stopReason: 'stop',
        });
      },
      subscribe: (fn) => {
        events.add(fn);
        return () => events.delete(fn);
      },
      abort: async () => {
        releaseInitialRun?.();
      },
      dispose: () => {},
    };
    return { session, sessionId: 'child-steerable' };
  };

  const jobs = new JobRegistry();
  const manager = new SubagentManager(jobs, { changed: () => {} }, createSteerableSession);

  // 1. Main Agent launches foreground subagent
  const fgPromise = manager.spawn(ctx, {
    agent: 'explore',
    description: 'Audit backend endpoints',
    prompt: 'Check all controllers.',
  });

  await initialRunStarted.promise;

  // 2. User types a message + Enter in Main TUI -> auto-backgrounds foreground subagents
  const backgrounded = jobs.backgroundAll('parent-session', 'subagent');
  assert.equal(backgrounded.length, 1);

  const bgReceipt = await fgPromise;
  assert.equal(bgReceipt.status, 'running');
  assert.equal(bgReceipt.sessionId, 'child-steerable');
  assert.match(bgReceipt.output, /working in the background/);
  assert.match(bgReceipt.output, /steer this running subagent/);

  // 3. Main Agent steers the running subagent and waits for it to finish
  const steeredResult = await manager.spawn(ctx, {
    agent: 'explore',
    sessionID: 'child-steerable',
    description: 'Audit backend endpoints',
    prompt: 'Also check DroneLeaseController specifically.',
  });

  assert.equal(steeredMessages.length, 1);
  assert.match(steeredMessages[0], /Also check DroneLeaseController specifically/);
  assert.equal(steeredResult.status, 'completed');
  assert.match(steeredResult.output, /Finished initial task plus steered instructions \(1\)/);
});


