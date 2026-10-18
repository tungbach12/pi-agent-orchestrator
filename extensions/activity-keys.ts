import type { EditorComponent, TUI } from '@earendil-works/pi-tui';

export function shouldInstallEditorHook<T>(currentFactory: T | undefined, installedFactory: T | undefined): boolean {
  return installedFactory === undefined || currentFactory !== installedFactory;
}

export function shouldOpenActivityFromEditorInput(
  isDownArrow: boolean,
  editor: EditorComponent,
  tui: Pick<TUI, 'hasOverlay'>,
): boolean {
  if (!isDownArrow || tui.hasOverlay() || editor.getText().trim().length > 0) return false;
  const state = editor as EditorComponent & { isShowingAutocomplete?: () => boolean };
  return !state.isShowingAutocomplete?.();
}
