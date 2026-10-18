import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldInstallEditorHook, shouldOpenActivityFromEditorInput } from '../extensions/activity-keys.ts';

test('installs and preserves the editor hook correctly across sessions', () => {
  const installed = () => {};
  const otherExtension = () => {};
  assert.equal(shouldInstallEditorHook(undefined, undefined), true);
  assert.equal(shouldInstallEditorHook(installed, installed), false);
  assert.equal(shouldInstallEditorHook(otherExtension, installed), true);
});

test('opens from the empty editor only on down', () => {
  const editor = { getText: () => '', isShowingAutocomplete: () => false };
  const tui = { hasOverlay: () => false };
  assert.equal(shouldOpenActivityFromEditorInput(true, editor, tui), true);
  assert.equal(shouldOpenActivityFromEditorInput(false, editor, tui), false);
  assert.equal(shouldOpenActivityFromEditorInput(true, { ...editor, getText: () => 'draft' }, tui), false);
});

test('does not open while Pi owns focus for overlays or autocomplete', () => {
  const editor = { getText: () => '', isShowingAutocomplete: () => false };
  assert.equal(shouldOpenActivityFromEditorInput(true, editor, { hasOverlay: () => true }), false);
  assert.equal(shouldOpenActivityFromEditorInput(true, { ...editor, isShowingAutocomplete: () => true }, { hasOverlay: () => false }), false);
});
