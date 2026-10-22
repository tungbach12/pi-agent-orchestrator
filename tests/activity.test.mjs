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
