import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';

const packageRoot = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const jiti = createJiti(pathToFileURL(join(packageRoot, 'extensions', 'activity.ts')).href, {
  alias: {
    '@earendil-works/pi-tui': join(packageRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  },
});
const { ActivityDocument, shouldOpenActivityFromEditorInput, tabAfterActivityRefresh } = await jiti.import(
  join(packageRoot, 'extensions', 'activity.ts'),
);

test('automatic tab selection follows available jobs until the user selects a tab', () => {
  assert.equal(tabAfterActivityRefresh('subagents', 0, 1, false), 'shell');
  assert.equal(tabAfterActivityRefresh('shell', 0, 1, true), 'shell');
  assert.equal(tabAfterActivityRefresh('subagents', 0, 1, true), 'subagents');
  assert.equal(tabAfterActivityRefresh('shell', 1, 0, false), 'subagents');
});

test('the dock opens only from an empty editor on down', () => {
  const editor = { getText: () => '', isShowingAutocomplete: () => false };
  const tui = { hasOverlay: () => false };
  assert.equal(shouldOpenActivityFromEditorInput(true, editor, tui), true);
  assert.equal(shouldOpenActivityFromEditorInput(false, editor, tui), false);
  assert.equal(shouldOpenActivityFromEditorInput(true, { ...editor, getText: () => 'draft' }, tui), false);
});

test('the dock does not open while Pi owns focus', () => {
  const editor = { getText: () => '', isShowingAutocomplete: () => false };
  assert.equal(shouldOpenActivityFromEditorInput(true, editor, { hasOverlay: () => true }), false);
  assert.equal(
    shouldOpenActivityFromEditorInput(true, { ...editor, isShowingAutocomplete: () => true }, { hasOverlay: () => false }),
    false,
  );
});

test('manual tab selection remains on the empty subagents tab when shells exist', () => {
  const store = {
    shells: () => [
      {
        shellID: 'shell-1',
        command: 'npm run dev',
        cwd: '.',
        file: 'output.log',
        startedAt: 0,
        status: 'running',
        output: '',
        truncated: false,
      },
    ],
    children: () => [],
    cancel: () => {},
    close: () => {},
  };
  const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } };
  const theme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    style: (text) => text,
  };
  const dock = new ActivityDocument(tui, theme, store);

  try {
    dock.render(80);
    dock.handleInput('\x1b[D');
    const rendered = dock.render(80).join('\n');

    assert.match(rendered, /No subagents running\./);
  } finally {
    dock.dispose();
  }
});

test('subagent detail view renders in Pi main-session style with visible thinking, nested codemode calls, and no false right-edge ellipses', () => {
  const store = {
    shells: () => [],
    children: () => [
      {
        sessionId: 'child-1',
        parentSessionId: 'parent-1',
        description: 'Explore backend MF3 references',
        agent: 'explore',
        status: 'completed',
        startedAt: 1000,
        completedAt: 3500,
        lastPrompt: 'You are a subagent spawned by another session.\nFind all references to evidence and findings.',
        thinking: 'Checking src/main and src/test for column references.',
        result: '### Findings\n- Updated V1__baseline.sql',
        tools: [
          {
            toolCallId: 'call-cm',
            name: 'codemode',
            input: { code: 'const res = await tools.grep({ pattern: "evidence" });\nreturn res;' },
            startedAt: 1200,
            completedAt: 1900,
            durationMs: 700,
            status: 'completed',
            output: 'Script completed\nWall time 0.7 seconds\nOutput:\n\nFound 3 matches',
          },
          {
            toolCallId: 'call-cm/1',
            parentToolCallId: 'call-cm',
            name: 'grep',
            input: { pattern: 'evidence', path: 'src/main' },
            startedAt: 1300,
            completedAt: 1600,
            durationMs: 300,
            status: 'completed',
            output: 'src/main/V1.sql:10: evidence',
          },
          {
            toolCallId: 'call-read',
            name: 'read',
            input: { path: 'src/main/App.ts', offset: 1, limit: 50 },
            startedAt: 2000,
            completedAt: 2100,
            status: 'completed',
            output: 'const x = 1;\nconst y = 2;',
          },
        ],
      },
    ],
    cancel: () => {},
    close: () => {},
  };
  const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 100 } };
  const theme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    style: (text) => text,
  };
  const dock = new ActivityDocument(tui, theme, store);

  try {
    dock.render(100);
    // Press Enter to open detail view
    dock.handleInput('\r');
    const lines = dock.render(100);
    const rendered = lines.join('\n');

    // 1. Internal FRESH_PROMPT is stripped; actual prompt is shown
    assert.ok(!rendered.includes('You are a subagent spawned by another session.'));
    assert.match(rendered, /Find all references to evidence and findings\./);

    // 2. Thinking is visible by default without needing to press 't' first, and stops at first tool start (200ms)
    assert.match(rendered, /▼ Thought · 200ms/);
    assert.match(rendered, /Checking src\/main and src\/test for column references\./);

    // 3. Nested codemode tool call is rendered compactly inside codemode (with Script completed header stripped)
    assert.match(rendered, /codemode/);
    assert.match(rendered, /✓ grep \/evidence\/ in src\/main 300ms/);
    assert.ok(!rendered.includes('Script completed'));
    assert.match(rendered, /Found 3 matches/);

    // 4. Read tool is formatted in Pi's 1-line style (`read src/main/App.ts:1-50`) and hides output when collapsed
    assert.match(rendered, /read src\/main\/App\.ts:1-50/);
    assert.ok(!rendered.includes('const x = 1;'), 'collapsed read call hides file content');

    // 5. Pressing 'e' expands tool outputs (revealing read content)
    dock.handleInput('e');
    const expandedRendered = dock.render(100).join('\n');
    assert.match(expandedRendered, /const x = 1;/);

    // 6. Pressing 't' collapses thinking trace
    dock.handleInput('t');
    const collapsedThoughtRendered = dock.render(100).join('\n');
    assert.ok(!collapsedThoughtRendered.includes('Checking src/main and src/test for column references.'));

    // 7. No false right-edge '…' truncation on body lines
    const bodyLines = lines.slice(2, -1);
    assert.ok(
      bodyLines.every((line) => !line.trimEnd().endsWith('…')),
      'body lines must wrap cleanly without false right-edge ellipsis truncation',
    );
  } finally {
    dock.dispose();
  }
});

test('thinking timer stops once thinking finishes and mouse wheel scrolls in natural direction', () => {
  const store = {
    shells: () => [],
    children: () => [
      {
        sessionId: 'child-running',
        parentSessionId: 'parent-1',
        description: 'Running tools after thought',
        agent: 'explore',
        status: 'running',
        startedAt: Date.now() - 30_000,
        isThinking: false,
        thinkingDurationMs: 1400,
        lastPrompt: Array.from({ length: 10 }, (_, i) => `Prompt line ${i + 1}`).join('\n'),
        thinking: 'Done thinking, now running tools.',
        tools: [
          {
            toolCallId: 't-1',
            name: 'grep',
            input: { pattern: 'foo', path: 'src' },
            startedAt: Date.now() - 28_000,
            status: 'running',
          },
        ],
      },
    ],
    cancel: () => {},
    close: () => {},
  };
  const tui = { requestRender: () => {}, terminal: { rows: 14, columns: 80 } };
  const theme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    style: (text) => text,
  };
  const dock = new ActivityDocument(tui, theme, store);

  try {
    dock.render(80);
    dock.handleInput('\r');
    const topRender = dock.render(80).join('\n');
    assert.match(topRender, /Prompt line 1\b/);
    assert.match(topRender, /↓ Jump to latest message · Ctrl\+End/);

    // Wheel down (positive wheelDelta in pi-tui) scrolls down to later lines.
    dock.handleMouse({ type: 'wheel', button: 'none', x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 14, shift: false, alt: false, ctrl: false, wheelDelta: 8 });
    const scrolledDown = dock.render(80).join('\n');
    assert.ok(!/Prompt line 1\b/.test(scrolledDown), 'scrolling down moves past top line');
    assert.match(scrolledDown, /▼ Thought · 1\.4s/, 'thinking timer stays frozen at 1.4s while tools run');

    // Wheel up (negative wheelDelta in pi-tui) scrolls back up to the top.
    dock.handleMouse({ type: 'wheel', button: 'none', x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 14, shift: false, alt: false, ctrl: false, wheelDelta: -8 });
    const scrolledUp = dock.render(80).join('\n');
    assert.match(scrolledUp, /Prompt line 1\b/, 'scrolling up returns to top line');
    assert.match(scrolledUp, /↓ Jump to latest message · Ctrl\+End/);

    // Clicking the "Jump to latest message" pill jumps straight to the bottom and hides the pill.
    dock.handleMouse({ type: 'click', button: 'left', x: 40, y: 12, screenX: 40, screenY: 12, width: 80, height: 14, shift: false, alt: false, ctrl: false, clickCount: 1 });
    const atBottom = dock.render(80).join('\n');
    assert.ok(!/↓ Jump to latest message · Ctrl\+End/.test(atBottom), 'pill disappears at bottom');
  } finally {
    dock.dispose();
  }
});

test('completed and running items are both visible by default without toggling ctrl+a', () => {
  const store = {
    shells: () => [],
    children: () => [
      {
        sessionId: 'c-running',
        parentSessionId: 'p-1',
        description: 'Active task',
        agent: 'explore',
        status: 'running',
        startedAt: 2000,
        tools: [],
      },
      {
        sessionId: 'c-done',
        parentSessionId: 'p-1',
        description: 'Finished task',
        agent: 'code',
        status: 'completed',
        startedAt: 1000,
        completedAt: 1500,
        tools: [],
      },
    ],
    cancel: () => {},
    close: () => {},
  };
  const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } };
  const theme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    style: (text) => text,
  };
  const dock = new ActivityDocument(tui, theme, store);

  try {
    const rendered = dock.render(80).join('\n');
    assert.match(rendered, /Explore: Active task/);
    assert.match(rendered, /Code: Finished task/);
    assert.ok(!rendered.includes('ctrl+a'), 'ctrl+a toggle is removed from footer');
  } finally {
    dock.dispose();
  }
});

test('detail view caches rendered body lines so scrolling and mouse movement stay sub-millisecond on large transcripts', () => {
  const tools = Array.from({ length: 80 }, (_, idx) => ({
    toolCallId: `t-${idx}`,
    name: idx % 2 === 0 ? 'grep' : 'bash',
    input: idx % 2 === 0 ? { pattern: `pattern_${idx}`, path: 'src' } : { command: `git log -n ${idx + 1}` },
    startedAt: 1000 + idx * 100,
    completedAt: 1050 + idx * 100,
    durationMs: 50,
    status: 'completed',
    output: Array.from({ length: 200 }, (__, lineIdx) => `src/file_${idx}.ts:${lineIdx + 1}: match content line`).join('\n'),
  }));
  const store = {
    shells: () => [],
    children: () => [
      {
        sessionId: 'c-large',
        parentSessionId: 'p-1',
        description: 'Large transcript',
        agent: 'explore',
        status: 'completed',
        startedAt: 1000,
        completedAt: 20000,
        thinkingDurationMs: 1500,
        lastPrompt: 'Search across the entire repository for all endpoints and services.',
        thinking: Array.from({ length: 40 }, (_, i) => `Thinking step ${i + 1}: analyzing module structure and dependencies.`).join('\n\n'),
        tools,
        result: Array.from({ length: 120 }, (_, i) => `### Section ${i + 1}\n- Finding ${i + 1} in \`src/module_${i}.ts:${i * 10 + 1}\``).join('\n\n'),
      },
    ],
    cancel: () => {},
    close: () => {},
  };
  const tui = { requestRender: () => {}, terminal: { rows: 30, columns: 100 } };
  const theme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    style: (text) => text,
  };
  const dock = new ActivityDocument(tui, theme, store);

  try {
    dock.render(100);
    dock.handleInput('\r');
    // Warm initial detail render
    dock.render(100);

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      dock.handleMouse({
        type: 'wheel',
        button: 'none',
        x: 10,
        y: 10,
        screenX: 10,
        screenY: 10,
        width: 100,
        height: 30,
        shift: false,
        alt: false,
        ctrl: false,
        wheelDelta: i % 2 === 0 ? 5 : -3,
      });
      dock.handleMouse({
        type: 'move',
        button: 'none',
        x: 10,
        y: (i % 20) + 3,
        screenX: 10,
        screenY: (i % 20) + 3,
        width: 100,
        height: 30,
        shift: false,
        alt: false,
        ctrl: false,
      });
      dock.render(100);
    }
    const elapsedMs = performance.now() - start;
    assert.ok(elapsedMs < 150, `100 scroll+hover+render frames on 80-tool transcript should be fast (took ${elapsedMs.toFixed(1)}ms)`);
  } finally {
    dock.dispose();
  }
});

