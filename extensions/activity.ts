import * as os from 'node:os';
import {
  Box,
  Container,
  Markdown,
  Spacer,
  Text,
  compositeTuiLine,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type MarkdownTheme,
  type TUI,
  type TuiMouseEvent,
} from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { FRESH_PROMPT } from './prompts.js';
import type { ChildSessionRecord } from './subagent.js';
import type { ShellRecord, ToolRecord } from './types.js';

const MAX_VISIBLE_ROWS = 7;
const DETAIL_REFRESH_INTERVAL_MS = 200;
const SCRIPT_HEADER = /^Script (?:completed|failed)\r?\nWall time [\d.]+ seconds\r?\nOutput:\r?\n+/;

export type ActivityTab = 'subagents' | 'shell';

type ActivityItem = { kind: 'subagent'; value: ChildSessionRecord } | { kind: 'shell'; value: ShellRecord };

export interface ActivityStore {
  shells(): ShellRecord[];
  children(): ChildSessionRecord[];
  cancel(id: string): void;
  close(): void;
}

/**
 * Picks the tab to show after a refresh.
 *
 * The dock follows the work that is actually running until the user picks a tab
 * themselves; after that their choice sticks.
 */
export function tabAfterActivityRefresh(
  tab: ActivityTab,
  childCount: number,
  shellCount: number,
  manuallySelected: boolean,
): ActivityTab {
  if (manuallySelected) return tab;
  if (tab === 'subagents' && childCount === 0 && shellCount > 0) return 'shell';
  if (tab === 'shell' && shellCount === 0 && childCount > 0) return 'subagents';
  return tab;
}

/**
 * Whether the dock may open for this key press.
 *
 * The editor must be empty and idle: while an overlay, an autocomplete popup,
 * or a draft is present the key belongs to the editor, not to the dock.
 */
export function shouldOpenActivityFromEditorInput(
  isDownArrow: boolean,
  editor: { getText(): string; isShowingAutocomplete?(): boolean },
  tui: { hasOverlay(): boolean },
): boolean {
  if (!isDownArrow) return false;
  if (tui.hasOverlay()) return false;
  if (editor.getText().trim().length > 0) return false;
  return !editor.isShowingAutocomplete?.();
}

/** Whether the editor hook has to be installed again. */
export function shouldInstallEditorHook<T>(currentFactory: T | undefined, installedFactory: T | undefined): boolean {
  return installedFactory === undefined || currentFactory !== installedFactory;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function statusLabel(status: string): string {
  if (status === 'queued') return 'Queued';
  if (status === 'running') return 'Running';
  if (status === 'completed') return 'Done';
  if (status === 'cancelled') return 'Stopped';
  return 'Failed';
}

function agentName(agent: string): string {
  if (!agent.length) return 'Subagent';
  return `${agent[0]!.toUpperCase()}${agent.slice(1)}`;
}

function themeItalic(theme: Theme, text: string): string {
  const maybeItalic = (theme as unknown as { italic?: (s: string) => string }).italic;
  return typeof maybeItalic === 'function' ? maybeItalic.call(theme, text) : text;
}

function themeBg(theme: Theme, color: Parameters<Theme['bg']>[0], text: string): string {
  return typeof theme.bg === 'function' ? theme.bg(color, text) : text;
}

/** Builds a `MarkdownTheme` bound to the active Pi `Theme` instance (safe in both TUI and unit tests). */
export function buildMarkdownTheme(theme: Theme): MarkdownTheme {
  const anyTheme = theme as unknown as {
    underline?: (s: string) => string;
    strikethrough?: (s: string) => string;
  };
  return {
    heading: (text) => theme.fg('mdHeading', theme.bold(text)),
    link: (text) => theme.fg('mdLink', text),
    linkUrl: (text) => theme.fg('mdLinkUrl', text),
    code: (text) => theme.fg('mdCode', text),
    codeBlock: (text) => theme.fg('mdCodeBlock', text),
    codeBlockBorder: (text) => theme.fg('mdCodeBlockBorder', text),
    quote: (text) => theme.fg('mdQuote', text),
    quoteBorder: (text) => theme.fg('mdQuoteBorder', text),
    hr: (text) => theme.fg('mdHr', text),
    listBullet: (text) => theme.fg('mdListBullet', text),
    bold: (text) => theme.bold(text),
    italic: (text) => themeItalic(theme, text),
    underline: (text) => (typeof anyTheme.underline === 'function' ? anyTheme.underline.call(theme, text) : text),
    strikethrough: (text) =>
      typeof anyTheme.strikethrough === 'function' ? anyTheme.strikethrough.call(theme, text) : text,
  };
}

function shortenPath(rawPath: unknown): string {
  if (typeof rawPath !== 'string' || !rawPath) return '';
  const home = os.homedir();
  const normalized = rawPath.replace(/\\/g, '/');
  const normHome = home.replace(/\\/g, '/');
  if (normalized.startsWith(normHome)) {
    return `~${normalized.slice(normHome.length)}`;
  }
  return normalized;
}

function formatReadRange(input: Record<string, unknown>): string {
  const offset = typeof input.offset === 'number' ? input.offset : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : undefined;
  if (offset === undefined && limit === undefined) return '';
  const start = offset ?? 1;
  if (limit === undefined) return `:${start}`;
  return `:${start}-${start + limit - 1}`;
}

function formatArgsPreview(input: unknown, expanded: boolean): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return '';
  if (expanded) {
    return entries
      .map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n');
  }
  const pairs = entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  return pairs.length > 90 ? `${pairs.slice(0, 87)}...` : pairs;
}

/** Formats a single tool call header line matching Pi's main session tool renderers. */
function formatToolCallHeader(tool: ToolRecord, theme: Theme, expanded: boolean): string {
  const args = (tool.input && typeof tool.input === 'object' ? tool.input : {}) as Record<string, unknown>;
  const title = (name: string) => theme.fg('toolTitle', theme.bold(name));

  switch (tool.name) {
    case 'read': {
      const path = shortenPath(args.file_path ?? args.path) || '...';
      const range = formatReadRange(args);
      return `${title('read')} ${theme.fg('accent', path)}${range ? theme.fg('warning', range) : ''}`;
    }
    case 'grep': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      const path = shortenPath(args.path) || '.';
      const glob = typeof args.glob === 'string' && args.glob ? ` (${args.glob})` : '';
      return `${title('grep')} ${theme.fg('accent', `/${pattern}/`)}${theme.fg('toolOutput', ` in ${path}${glob}`)}`;
    }
    case 'find': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      const path = shortenPath(args.path) || '.';
      return `${title('find')} ${theme.fg('accent', pattern)}${theme.fg('toolOutput', ` in ${path}`)}`;
    }
    case 'ls': {
      const path = shortenPath(args.path) || '.';
      return `${title('ls')} ${theme.fg('accent', path)}`;
    }
    case 'edit':
    case 'write': {
      const path = shortenPath(args.file_path ?? args.path) || '...';
      return `${title(tool.name)} ${theme.fg('accent', path)}`;
    }
    case 'bash': {
      const cmd = typeof args.command === 'string' ? args.command.replace(/\r/g, '').trim() : '...';
      const timeout = typeof args.timeout === 'number' ? theme.fg('muted', ` (timeout ${args.timeout}s)`) : '';
      return `${title(`$ ${cmd}`)}${timeout}`;
    }
    case 'codemode': {
      const code = typeof args.code === 'string' ? args.code.replace(/\r/g, '').trimEnd() : '';
      if (!code) return title('codemode');
      const codeLines = code.split('\n');
      const maxCodeLines = expanded ? codeLines.length : 5;
      const shown = codeLines.slice(0, maxCodeLines).map((l) => theme.fg('muted', l.replace(/\t/g, '  ')));
      if (codeLines.length > maxCodeLines) {
        shown.push(theme.fg('dim', `... (${codeLines.length - maxCodeLines} more lines, e/click to expand)`));
      }
      return `${title('codemode')}\n${shown.join('\n')}`;
    }
    default: {
      const preview = formatArgsPreview(tool.input, expanded);
      if (!preview) return title(tool.name);
      return expanded
        ? `${title(tool.name)}\n${theme.fg('muted', preview)}`
        : `${title(tool.name)} ${theme.fg('muted', preview)}`;
    }
  }
}

/** Formats a nested call inside a `codemode` block (`✓ grep /foo/ in src 12ms`). */
function formatNestedCallLine(nested: ToolRecord, theme: Theme): string {
  const icon =
    nested.status === 'running'
      ? theme.fg('warning', '…')
      : nested.status === 'error'
        ? theme.fg('error', '✗')
        : theme.fg('success', '✓');
  const args = (nested.input && typeof nested.input === 'object' ? nested.input : {}) as Record<string, unknown>;
  let summary = '';
  if (nested.name === 'read' || nested.name === 'edit' || nested.name === 'write' || nested.name === 'ls') {
    summary = shortenPath(args.file_path ?? args.path) || '.';
  } else if (nested.name === 'grep' || nested.name === 'find') {
    const pat = typeof args.pattern === 'string' ? args.pattern : '';
    const p = shortenPath(args.path) || '.';
    summary = `${pat ? `${nested.name === 'grep' ? `/${pat}/` : pat} ` : ''}in ${p}`;
  } else if (nested.name === 'bash') {
    summary = typeof args.command === 'string' ? args.command.split('\n', 1)[0]!.slice(0, 60) : '';
  } else {
    summary = formatArgsPreview(nested.input, false).slice(0, 60);
  }
  const durMs = nested.durationMs ?? (nested.completedAt ? nested.completedAt - nested.startedAt : undefined);
  const dur = durMs !== undefined ? ` ${theme.fg('dim', formatDuration(durMs))}` : '';
  return `${icon} ${theme.fg('toolTitle', nested.name)}${summary ? ` ${theme.fg('muted', summary)}` : ''}${dur}`;
}

/** Formats the body of a tool box (call header + nested calls + output preview + timing) in Pi's main TUI style. */
function formatToolBoxText(
  tool: ToolRecord,
  nestedCalls: readonly ToolRecord[],
  theme: Theme,
  expanded: boolean,
): string {
  const parts: string[] = [formatToolCallHeader(tool, theme, expanded)];

  if (tool.name === 'codemode' && nestedCalls.length > 0) {
    const maxNested = expanded ? nestedCalls.length : 8;
    const shown = nestedCalls.slice(-maxNested);
    const nestedLines: string[] = [];
    if (shown.length < nestedCalls.length) {
      nestedLines.push(theme.fg('dim', `... (${nestedCalls.length - shown.length} earlier calls, e/click to expand)`));
    }
    for (const item of shown) {
      nestedLines.push(formatNestedCallLine(item, theme));
    }
    parts.push(nestedLines.join('\n'));
  }

  // Like Pi's readRenderers, successful `read` calls stay 1-line when collapsed.
  const canShowOutput = Boolean(tool.output) && (tool.name !== 'read' || expanded || tool.status === 'error');
  if (canShowOutput) {
    const rawOutput = (tool.output ?? '').replace(/\r/g, '');
    const cleanedOutput = tool.name === 'codemode' ? rawOutput.replace(SCRIPT_HEADER, '').trim() : rawOutput.trim();
    if (cleanedOutput.length > 0) {
      const outColor = tool.status === 'error' ? 'error' : 'toolOutput';
      const lines = cleanedOutput.split('\n');
      if (expanded) {
        const cap = 60;
        const sliced = lines.slice(0, cap).map((l) => theme.fg(outColor, l.replace(/\t/g, '   ')));
        if (lines.length > cap) {
          sliced.push(theme.fg('muted', `... (${lines.length - cap} more lines)`));
        }
        parts.push(sliced.join('\n'));
      } else if (tool.name === 'bash') {
        // Pi's bash renderer previews the last 5 lines.
        const maxPreview = 5;
        const tail = lines.slice(-maxPreview).map((l) => theme.fg(outColor, l.replace(/\t/g, '   ')));
        if (lines.length > maxPreview) {
          tail.unshift(theme.fg('muted', `... (${lines.length - maxPreview} earlier lines, e/click to expand)`));
        }
        parts.push(tail.join('\n'));
      } else {
        const maxPreview = 4;
        const head = lines.slice(0, maxPreview).map((l) => theme.fg(outColor, l.replace(/\t/g, '   ')));
        if (lines.length > maxPreview) {
          head.push(theme.fg('muted', `... (${lines.length - maxPreview} more lines, e/click to expand)`));
        }
        parts.push(head.join('\n'));
      }
    }
  }

  if (tool.name === 'bash' || tool.name === 'codemode') {
    const durMs = tool.durationMs ?? (tool.completedAt ? tool.completedAt - tool.startedAt : Date.now() - tool.startedAt);
    const label = tool.status === 'running' ? `Elapsed ${formatDuration(durMs)}` : `Took ${formatDuration(durMs)}`;
    parts.push(theme.fg('muted', label));
  }

  return parts.join('\n');
}

/**
 * The activity dock.
 *
 * It lists the running commands and child agents, and opens a detail view
 * styled after Pi's main session TUI (UserMessage box, Thinking trace,
 * ToolExecution boxes, and Assistant response).
 */
export class ActivityDocument implements Component, Focusable {
  private body = new Container();
  private detailScrollTop = 0;
  private detailBodyHeight = 0;
  private detailContentHeight = 0;
  private content: Component[] = [];
  private cachedBodyLines: string[] = [];
  private cachedBodyWidth = 0;
  private bodyDirty = true;
  private groupRanges: Array<{ start: number; end: number; item: ToggleableComponent }> = [];
  private toolBoxCache = new Map<string, ToolExecutionBox>();
  private promptCache = new Map<string, { text: string; component: Markdown; width?: number; lines?: string[] }>();
  private resultCache = new Map<string, { text: string; component: Markdown; width?: number; lines?: string[] }>();
  private staticLineCache = new WeakMap<Component, { width: number; lines: string[] }>();
  private thinkingSectionCache = new Map<string, ThinkingSection>();
  private expanded = new Map<string, boolean>();
  private allToolsExpanded = false;
  private hoveredGroup?: string;
  private _focused = true;
  private lastSignature = '';
  private renderWidth = 80;
  private activeTab: ActivityTab = 'subagents';
  private tabManuallySelected = false;
  private selectedIndex = 0;
  private detailKey?: string;
  private scrollToEndRect?: { row: number; column: number; width: number };
  private actionNotice?: string;
  private refreshTimer: NodeJS.Timeout;
  private visibleItems: ActivityItem[] = [];
  private visibleStart = 0;
  private rowStart = 2;
  private header: string[] = [];
  private footer: string[] = [];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly store: ActivityStore,
  ) {
    this.refreshTimer = setInterval(() => {
      const hasRunning =
        this.store.children().some((c) => c.status === 'running' || c.status === 'queued' || c.isThinking) ||
        this.store.shells().some((s) => s.status === 'running' || s.status === 'queued');
      if (hasRunning) {
        this.tui.requestRender();
      }
    }, DETAIL_REFRESH_INTERVAL_MS);
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
  }

  private items(): ActivityItem[] {
    return this.activeTab === 'subagents'
      ? this.store.children().map((value) => ({ kind: 'subagent', value }))
      : this.store.shells().map((value) => ({ kind: 'shell', value }));
  }

  private selectedItem(): ActivityItem | undefined {
    return this.items()[this.selectedIndex];
  }

  private scrollDetail(delta: number): void {
    this.detailScrollTop = Math.max(
      0,
      Math.min(Math.max(0, this.detailContentHeight - this.detailBodyHeight), this.detailScrollTop + delta),
    );
  }

  private scrollToBottom(): void {
    this.detailScrollTop = Math.max(0, this.detailContentHeight - this.detailBodyHeight);
  }

  private itemId(item: ActivityItem): string {
    return item.kind === 'subagent' ? item.value.sessionId : item.value.shellID;
  }

  private selectedId(item: ActivityItem | undefined): string | undefined {
    return item ? `${item.kind}:${this.itemId(item)}` : undefined;
  }

  private enterDetail(item = this.selectedItem()): void {
    if (!item) return;
    this.detailKey = this.selectedId(item);
    this.detailScrollTop = 0;
    this.actionNotice = undefined;
    this.lastSignature = '';
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const items = this.items();
    if (this.detailKey) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'left') || matchesKey(data, 'backspace') || data === 'q') {
        this.detailKey = undefined;
        this.scrollToEndRect = undefined;
        this.lastSignature = '';
      } else if (matchesKey(data, 'up')) this.scrollDetail(-1);
      else if (matchesKey(data, 'down')) this.scrollDetail(1);
      else if (matchesKey(data, 'pageUp')) this.scrollDetail(-8);
      else if (matchesKey(data, 'pageDown')) this.scrollDetail(8);
      else if (matchesKey(data, 'ctrl+end') || matchesKey(data, 'end') || data === 'G') this.scrollToBottom();
      else if (matchesKey(data, 'ctrl+home') || matchesKey(data, 'home') || data === 'g') this.detailScrollTop = 0;
      else if (matchesKey(data, 'ctrl+d') || data === 'x') this.interruptSelected();
      else if (data === 't' || data === 'T') this.toggleThought();
      else if (data === 'e' || data === 'E' || data === 'o' || data === 'O' || matchesKey(data, 'ctrl+o')) {
        this.toggleAllTools();
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, 'escape') || data === 'q') {
      this.store.close();
      return;
    }
    if (matchesKey(data, 'up')) {
      if (this.selectedIndex === 0 || items.length === 0) {
        this.store.close();
        return;
      }
      this.selectedIndex--;
    } else if (matchesKey(data, 'down')) {
      if (items.length) this.selectedIndex = Math.min(items.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, 'left') || matchesKey(data, 'right') || matchesKey(data, 'tab')) {
      this.activeTab = this.activeTab === 'subagents' ? 'shell' : 'subagents';
      this.tabManuallySelected = true;
      this.selectedIndex = 0;
    } else if (matchesKey(data, 'enter') || data === ' ') this.enterDetail();
    else if (matchesKey(data, 'ctrl+d') || data === 'x') this.interruptSelected();
    this.lastSignature = '';
    this.tui.requestRender();
  }

  private interruptSelected(): void {
    const selected = this.detailKey ? this.findItem(this.detailKey) : this.selectedItem();
    if (!selected || (selected.value.status !== 'running' && selected.value.status !== 'queued')) return;
    this.store.cancel(this.itemId(selected));
    this.actionNotice = `Interrupted ${selected.kind === 'subagent' ? selected.value.description : selected.value.command}`;
    this.lastSignature = '';
    this.tui.requestRender();
  }

  private findItem(key: string): ActivityItem | undefined {
    const [kind, id] = key.split(':', 2);
    if (kind === 'subagent') {
      const value = this.store.children().find((child) => child.sessionId === id);
      return value ? { kind: 'subagent', value } : undefined;
    }
    const value = this.store.shells().find((shell) => shell.shellID === id);
    return value ? { kind: 'shell', value } : undefined;
  }

  private toggleThought(): void {
    if (!this.detailKey) return;
    const key = `thought:${this.detailKey.slice(this.detailKey.indexOf(':') + 1)}`;
    // Thinking defaults to expanded (true) when present, so toggling flips from true -> false.
    const current = this.expanded.get(key) ?? true;
    this.expanded.set(key, !current);
    this.lastSignature = '';
  }

  private toggleAllTools(): void {
    if (!this.detailKey) return;
    this.allToolsExpanded = !this.allToolsExpanded;
    const sessionId = this.detailKey.slice(this.detailKey.indexOf(':') + 1);
    for (const key of this.expanded.keys()) {
      if (key.startsWith(`tool:${sessionId}:`)) {
        this.expanded.set(key, this.allToolsExpanded);
      }
    }
    this.lastSignature = '';
  }

  handleMouse(event: TuiMouseEvent): { handled?: boolean; render?: boolean } | undefined {
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 1;
      if (this.detailKey) {
        this.scrollDetail(delta);
      } else if (this.items().length) {
        this.selectedIndex = Math.max(0, Math.min(this.items().length - 1, this.selectedIndex + (delta > 0 ? 1 : -1)));
        this.lastSignature = '';
      }
      this.tui.requestRender();
      return { handled: true, render: true };
    }
    if (event.type !== 'click' || event.button !== 'left') {
      if (event.type === 'move' && this.detailKey) this.updateHoveredGroup(event.y - this.header.length + this.detailScrollTop);
      return undefined;
    }

    if (this.detailKey) {
      if (
        this.scrollToEndRect &&
        event.y === this.scrollToEndRect.row &&
        event.x >= this.scrollToEndRect.column &&
        event.x < this.scrollToEndRect.column + this.scrollToEndRect.width
      ) {
        this.scrollToBottom();
        this.tui.requestRender();
        return { handled: true, render: true };
      }
      if (event.y >= this.header.length + this.detailBodyHeight) return undefined;
      if (event.y < this.header.length && event.x < 20) {
        this.detailKey = undefined;
        this.scrollToEndRect = undefined;
        this.lastSignature = '';
        this.tui.requestRender();
        return { handled: true, render: true };
      }
      const group = this.groupAt(event.y - this.header.length + this.detailScrollTop);
      if (group) {
        group.toggle();
        this.bodyDirty = true;
        this.lastSignature = '';
        this.tui.requestRender();
        return { handled: true, render: true };
      }
      return undefined;
    }

    if (event.y === 0) {
      if (event.x < 14) {
        this.activeTab = 'subagents';
        this.tabManuallySelected = true;
      } else if (event.x < 25) {
        this.activeTab = 'shell';
        this.tabManuallySelected = true;
      } else if (event.x >= this.renderWidth - 6) this.store.close();
      this.selectedIndex = 0;
      this.lastSignature = '';
      this.tui.requestRender();
      return { handled: true, render: true };
    }
    const row = event.y - this.rowStart;
    if (row >= 0 && row < this.visibleItems.length) {
      this.selectedIndex = this.visibleStart + row;
      if ((event.clickCount ?? 1) > 1) this.enterDetail(this.visibleItems[row]);
      else this.lastSignature = '';
      this.tui.requestRender();
      return { handled: true, render: true };
    }
    return undefined;
  }

  private updateHoveredGroup(target: number): void {
    const group = this.groupAt(target);
    if (this.hoveredGroup === group?.id) return;
    let needsRerender = false;
    if (this.hoveredGroup) {
      const previous = this.content.find((entry) => isToggleable(entry) && entry.id === this.hoveredGroup);
      if (previous && isToggleable(previous)) {
        previous.setHover(false);
        if (previous.id.startsWith('thought:')) needsRerender = true;
      }
    }
    if (group) {
      group.setHover(true);
      if (group.id.startsWith('thought:')) needsRerender = true;
    }
    this.hoveredGroup = group?.id;
    if (needsRerender) {
      this.bodyDirty = true;
      this.tui.requestRender();
    }
  }

  private detailContentWidth(): number {
    return Math.max(1, this.renderWidth - 2);
  }

  private groupAt(target: number): ToggleableComponent | undefined {
    for (const range of this.groupRanges) {
      if (target >= range.start && target < range.end) return range.item;
    }
    return undefined;
  }

  private buildDetailContent(item: ActivityItem): Component[] {
    const components: Component[] = [];
    const mdTheme = buildMarkdownTheme(this.theme);
    if (item.kind === 'subagent') {
      const child = item.value;
      const rawPrompt = child.lastPrompt || child.description || 'Subagent task';
      const cleanPrompt = rawPrompt.startsWith(`${FRESH_PROMPT}\n`)
        ? rawPrompt.slice(FRESH_PROMPT.length + 1)
        : rawPrompt;

      // 1. User Prompt Box (cached per sessionId + prompt text)
      let promptEntry = this.promptCache.get(child.sessionId);
      if (!promptEntry || promptEntry.text !== cleanPrompt) {
        promptEntry = {
          text: cleanPrompt,
          component: new Markdown(
            cleanPrompt,
            1,
            1,
            mdTheme,
            {
              color: (content) => this.theme.fg('userMessageText', content),
              bgColor: (content) => themeBg(this.theme, 'userMessageBg', content),
            },
            { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
          ),
        };
        this.promptCache.set(child.sessionId, promptEntry);
      }
      components.push(promptEntry.component);

      // 2. Thinking Block (reuses cached ThinkingSection so unchanged thinking Markdown is not re-parsed)
      const thoughtKey = `thought:${child.sessionId}`;
      const thoughtExpanded = this.expanded.get(thoughtKey) ?? true;
      const activelyThinking =
        child.isThinking === true ||
        (child.status === 'running' && child.thinkingDurationMs === undefined && child.tools.length === 0 && !child.result);
      const thinkingElapsedMs = activelyThinking
        ? (child.thinkingDurationMs ?? 0) + Math.max(0, Date.now() - (child.thinkingStartedAt ?? child.startedAt))
        : child.thinkingDurationMs !== undefined && child.thinkingDurationMs > 0
          ? child.thinkingDurationMs
          : child.tools[0]
            ? Math.max(0, child.tools[0].startedAt - child.startedAt)
            : Math.max(0, (child.completedAt ?? Date.now()) - child.startedAt);
      const elapsedText = formatDuration(thinkingElapsedMs);
      const thinkingText = child.thinking?.trim() ?? '';
      if (thinkingText || child.status === 'running' || child.status === 'queued') {
        components.push(new Spacer(1));
        let section = this.thinkingSectionCache.get(thoughtKey);
        if (!section) {
          section = new ThinkingSection(
            this.theme,
            mdTheme,
            thoughtKey,
            thinkingText,
            elapsedText,
            activelyThinking,
            child.status,
            thoughtExpanded,
            (val) => {
              this.expanded.set(thoughtKey, val);
              this.bodyDirty = true;
            },
          );
          this.thinkingSectionCache.set(thoughtKey, section);
        } else {
          section.update(thinkingText, elapsedText, activelyThinking, child.status, thoughtExpanded);
        }
        components.push(section);
      }

      // 3. Tool Execution Boxes (reuses cached ToolExecutionBox per toolKey so completed tools render in O(1))
      const topLevelTools = child.tools.filter((t) => !t.parentToolCallId);
      const nestedByParent = new Map<string, ToolRecord[]>();
      for (const tool of child.tools) {
        if (!tool.parentToolCallId) continue;
        const list = nestedByParent.get(tool.parentToolCallId) ?? [];
        list.push(tool);
        nestedByParent.set(tool.parentToolCallId, list);
      }

      topLevelTools.forEach((tool, idx) => {
        const toolKey = `tool:${child.sessionId}:${tool.toolCallId ?? idx}`;
        const isExpanded = this.expanded.get(toolKey) ?? this.allToolsExpanded;
        const nested = tool.toolCallId ? (nestedByParent.get(tool.toolCallId) ?? []) : [];
        components.push(new Spacer(1));
        let box = this.toolBoxCache.get(toolKey);
        if (!box) {
          box = new ToolExecutionBox(
            this.theme,
            toolKey,
            tool,
            nested,
            isExpanded,
            (val) => {
              this.expanded.set(toolKey, val);
              this.bodyDirty = true;
            },
          );
          this.toolBoxCache.set(toolKey, box);
        } else {
          box.update(tool, nested, isExpanded);
        }
        components.push(box);
      });

      // 4. Assistant Final / Streaming Response (cached per sessionId + result text)
      const trimmedResult = child.result?.trim() ?? '';
      if (trimmedResult) {
        components.push(new Spacer(1));
        let resultEntry = this.resultCache.get(child.sessionId);
        if (!resultEntry || resultEntry.text !== trimmedResult) {
          resultEntry = {
            text: trimmedResult,
            component: new Markdown(trimmedResult, 1, 0, mdTheme),
          };
          this.resultCache.set(child.sessionId, resultEntry);
        }
        components.push(resultEntry.component);
      }

      if (child.status === 'running') {
        const activeTool = [...child.tools].reverse().find((t) => t.status === 'running');
        const label = activeTool ? `Running ${activeTool.name}…` : 'Working…';
        components.push(new Spacer(1));
        components.push(new Text(this.theme.fg('warning', `● ${label}`), 1, 0));
      } else if (child.status === 'queued') {
        components.push(new Spacer(1));
        components.push(new Text(this.theme.fg('warning', '◷ Queued — waiting for an available worker slot…'), 1, 0));
      }

      if (child.error) {
        components.push(new Spacer(1));
        components.push(new Text(this.theme.fg('error', `Error: ${child.error}`), 1, 0));
      }
    } else {
      const shell = item.value;
      const bgColor =
        shell.status === 'running'
          ? 'toolPendingBg'
          : shell.status === 'error' || (shell.exitCode !== undefined && shell.exitCode !== 0)
            ? 'toolErrorBg'
            : 'toolSuccessBg';
      const box = new Box(1, 1, (t) => themeBg(this.theme, bgColor, t));
      const cmdHeader = this.theme.fg('toolTitle', this.theme.bold(`$ ${shell.command}`));
      const rawOut = shell.output.replace(/\r/g, '').trimEnd();
      const outLines = rawOut
        ? rawOut
            .split('\n')
            .slice(-100)
            .map((l) => this.theme.fg('toolOutput', l.replace(/\t/g, '   ')))
            .join('\n')
        : this.theme.fg('muted', '(no output)');
      const elapsed = formatDuration(Math.max(0, (shell.completedAt ?? Date.now()) - shell.startedAt));
      const footer = this.theme.fg(
        'muted',
        `${shell.status === 'running' ? `Elapsed ${elapsed}` : `Took ${elapsed}`}${shell.exitCode !== undefined ? ` · exit ${shell.exitCode}` : ''}`,
      );
      box.addChild(new Text(`${cmdHeader}\n\n${outLines}\n\n${footer}`, 0, 0));
      components.push(box);
      if (shell.error) {
        components.push(new Spacer(1));
        components.push(new Text(this.theme.fg('error', shell.error), 1, 0));
      }
    }
    return components;
  }

  /** Styles headings, bullets, and code blocks cleanly for assistant responses. */
  private formatAssistantText(text: string): string {
    return text
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => {
        if (/^#{1,6}\s+/.test(line)) {
          return this.theme.fg('accent', this.theme.bold(line));
        }
        return this.theme.fg('text', line);
      })
      .join('\n');
  }

  private refresh(): void {
    const children = this.store.children();
    const shells = this.store.shells();
    const detailItem = this.detailKey ? this.findItem(this.detailKey) : undefined;
    const detailActiveTimer =
      detailItem?.kind === 'subagent'
        ? detailItem.value.isThinking ||
          (detailItem.value.status === 'running' &&
            detailItem.value.thinkingDurationMs === undefined &&
            detailItem.value.tools.length === 0 &&
            !detailItem.value.result) ||
          detailItem.value.tools.some(
            (t) => t.status === 'running' && (t.name === 'bash' || t.name === 'codemode'),
          )
        : detailItem?.kind === 'shell'
          ? detailItem.value.status === 'running'
          : false;
    const timerTick = detailActiveTimer ? Math.floor(Date.now() / DETAIL_REFRESH_INTERVAL_MS) : 0;

    const signature = JSON.stringify([
      this.renderWidth,
      this.detailKey,
      this.activeTab,
      this.selectedIndex,
      this.actionNotice,
      this.allToolsExpanded,
      timerTick,
      [...this.expanded.entries()],
      detailItem
        ? detailItem.kind === 'subagent'
          ? [
              detailItem.value.sessionId,
              detailItem.value.status,
              detailItem.value.isThinking,
              detailItem.value.thinkingDurationMs,
              detailItem.value.tools.length,
              detailItem.value.tools.slice(-16).map((t) => [t.toolCallId, t.status, t.output?.length, t.durationMs]),
              detailItem.value.thinking?.length,
              detailItem.value.result?.length,
              detailItem.value.error,
            ]
          : [
              detailItem.value.shellID,
              detailItem.value.status,
              detailItem.value.output.length,
              detailItem.value.exitCode,
              detailItem.value.error,
            ]
        : [
            children.map((c) => [c.sessionId, c.status, c.description]),
            shells.map((s) => [s.shellID, s.status, s.command]),
          ],
    ]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.content = [];
    this.bodyDirty = true;
    this.renderWidth = Math.max(1, this.renderWidth);

    if (this.detailKey && !detailItem) this.detailKey = undefined;
    if (detailItem) {
      this.content = this.buildDetailContent(detailItem);
      this.body.clear();
      for (const entry of this.content) this.body.addChild(entry);
      const active = detailItem.value.status === 'running' || detailItem.value.status === 'queued';
      const activeStatus = detailItem.value.status === 'queued' ? '◷ Queued' : '● Running';
      const label =
        detailItem.kind === 'subagent'
          ? `@${detailItem.value.agent} · ${detailItem.value.description}`
          : detailItem.value.command;
      const status = active
        ? this.theme.fg(detailItem.value.status === 'queued' ? 'warning' : 'success', activeStatus)
        : detailItem.value.status === 'completed'
          ? this.theme.fg('dim', 'Done')
          : this.theme.fg('error', statusLabel(detailItem.value.status));
      const left = `  ${this.theme.bold('← Back (esc/←)')}   ${this.theme.fg('dim', label)}`;
      this.header = [this.line(left, status), this.line('')];
      this.footer = [
        this.line(
          `  ${this.theme.bold('back')} ${this.theme.fg('dim', 'esc/←')}  ${this.theme.bold('scroll')} ${this.theme.fg('dim', 'wheel/↑/↓')}  ${this.theme.bold('thought')} ${this.theme.fg('dim', 't/click')}  ${this.theme.bold('tools')} ${this.theme.fg('dim', 'e/click')}  ${this.theme.bold('interrupt')} ${this.theme.fg('dim', 'ctrl+d')}`,
        ),
      ];
      return;
    }

    this.body.clear();
    this.activeTab = tabAfterActivityRefresh(
      this.activeTab,
      children.length,
      shells.length,
      this.tabManuallySelected,
    );
    const items = this.items();
    this.selectedIndex = items.length ? Math.max(0, Math.min(this.selectedIndex, items.length - 1)) : 0;
    const rows = Math.max(1, Math.min(MAX_VISIBLE_ROWS, (this.tui.terminal.rows || 24) - 4));
    this.visibleStart = Math.max(0, Math.min(this.selectedIndex - rows + 1, Math.max(0, items.length - rows)));
    this.visibleItems = items.slice(this.visibleStart, this.visibleStart + rows);

    const subagentsLabel =
      this.activeTab === 'subagents' ? this.theme.bold('Subagents') : this.theme.fg('dim', 'Subagents');
    const shellLabel = this.activeTab === 'shell' ? this.theme.bold('Shell') : this.theme.fg('dim', 'Shell');
    const left = `  ${subagentsLabel}  ${shellLabel}`;
    const right = this.theme.fg('dim', 'esc  ');
    this.header = [this.line(left, right), this.line('')];

    const panelHeight = Math.min(this.tui.terminal.rows || 24, Math.max(10, rows + 5));
    const listLines: string[] = [...this.header];
    this.rowStart = listLines.length;
    for (let i = 0; i < rows; i++) {
      const item = this.visibleItems[i];
      if (!item) {
        listLines.push(this.line(''));
        continue;
      }
      const label =
        item.kind === 'subagent'
          ? `${agentName(item.value.agent)}: ${item.value.description}`
          : item.value.command.split('\n', 1)[0]!;
      const status =
        item.value.status === 'running'
          ? this.theme.fg('success', 'Running')
          : item.value.status === 'queued'
            ? this.theme.fg('warning', 'Queued')
            : statusLabel(item.value.status);
      listLines.push(this.row(label, status, this.visibleStart + i === this.selectedIndex));
    }
    if (!items.length) {
      listLines[this.rowStart] = this.line(
        `  ${this.theme.fg('dim', `No ${this.activeTab === 'subagents' ? 'subagents' : 'shell processes'} running.`)}`,
      );
    }
    while (listLines.length < panelHeight - 1) {
      listLines.push(this.line(this.actionNotice ? `  ${this.theme.fg('error', this.actionNotice)}` : ''));
    }
    listLines.push(
      this.line(
        `  ${this.theme.bold('interrupt')} ${this.theme.fg('dim', 'ctrl+d')}  ${this.theme.bold('open')} ${this.theme.fg('dim', 'enter')}  ${this.theme.bold('tabs')} ${this.theme.fg('dim', '←/→')}`,
      ),
    );
    this.header = listLines;
  }

  /** A full-width line with the given left and right text, framed by a border. */
  private line(left: string, right = ''): string {
    const width = this.renderWidth;
    const inner = Math.max(0, width - 1);
    const rightPad = right ? `${right} ` : '';
    const maxLeft = Math.max(0, inner - visibleWidth(rightPad) - 2);
    const clipped = visibleWidth(left) > maxLeft ? truncateToWidth(left, maxLeft, '…') : left;
    const padding = Math.max(1, inner - visibleWidth(clipped) - visibleWidth(rightPad) - 2);
    const body = `${clipped}${' '.repeat(padding)}${rightPad}`;
    return this.frame(body, inner);
  }

  /** Frames a pre-rendered detail body line (rendered at `width - 2`) without adding false right-edge ellipses. */
  private bodyLine(contentLine: string): string {
    const inner = Math.max(0, this.renderWidth - 1);
    return this.frame(` ${contentLine}`, inner);
  }

  /** A selectable row: the selected one is highlighted with the theme's selection background. */
  private row(left: string, right: string, selected: boolean): string {
    const width = this.renderWidth;
    const inner = Math.max(0, width - 1);
    const rightPad = right ? `${right} ` : '';
    const maxLeft = Math.max(0, inner - visibleWidth(rightPad) - 2);
    const clipped = visibleWidth(left) > maxLeft ? truncateToWidth(left, maxLeft, '…') : left;
    const padding = Math.max(1, inner - visibleWidth(clipped) - visibleWidth(rightPad) - 2);
    const body = ` ${clipped}${' '.repeat(padding)}${rightPad}`;
    const framed = this.frame(body, inner);
    return selected ? this.theme.style(framed, { bg: 'selectedBg', fg: 'text' }) : framed;
  }

  /** Wraps a line in the dock's left border. */
  private frame(body: string, inner: number): string {
    const border = this.theme.fg('border', '│');
    const clipped = visibleWidth(body) > inner ? truncateToWidth(body, inner, '…') : body;
    return `${border}${clipped}${' '.repeat(Math.max(0, inner - visibleWidth(clipped)))}`;
  }

  render(width: number): string[] {
    this.renderWidth = width;
    this.refresh();
    if (!this.detailKey) {
      this.scrollToEndRect = undefined;
      return this.header;
    }
    const height = Math.max(10, this.tui.terminal.rows || 24);
    const bodyHeight = Math.max(1, height - this.header.length - this.footer.length);
    const contentWidth = this.detailContentWidth();
    if (this.bodyDirty || this.cachedBodyWidth !== contentWidth) {
      const lines: string[] = [];
      const ranges: Array<{ start: number; end: number; item: ToggleableComponent }> = [];
      for (const item of this.content) {
        const start = lines.length;
        let itemLines: string[];
        if (isToggleable(item)) {
          itemLines = item.render(contentWidth);
        } else {
          const cached = this.staticLineCache.get(item);
          if (cached && cached.width === contentWidth) {
            itemLines = cached.lines;
          } else {
            itemLines = item.render(contentWidth);
            this.staticLineCache.set(item, { width: contentWidth, lines: itemLines });
          }
        }
        for (let i = 0; i < itemLines.length; i++) {
          lines.push(itemLines[i]!);
        }
        if (isToggleable(item)) {
          ranges.push({ start, end: lines.length, item });
        }
      }
      this.cachedBodyLines = lines;
      this.groupRanges = ranges;
      this.cachedBodyWidth = contentWidth;
      this.bodyDirty = false;
    }
    const rendered = this.cachedBodyLines;
    const maxScrollTop = Math.max(0, rendered.length - bodyHeight);
    this.detailBodyHeight = bodyHeight;
    this.detailContentHeight = rendered.length;
    this.detailScrollTop = Math.max(0, Math.min(this.detailScrollTop, maxScrollTop));
    const body = rendered
      .slice(this.detailScrollTop, this.detailScrollTop + bodyHeight)
      .map((line) => this.bodyLine(line));
    while (body.length < bodyHeight) body.push(this.line(''));

    // Composite Pi's `↓ Jump to latest message · Ctrl+End` pill on the last row
    // of the detail viewport whenever the transcript is scrolled up.
    if (this.detailScrollTop < maxScrollTop && body.length > 0) {
      const rawLabel = ' ↓ Jump to latest message · Ctrl+End ';
      const styledLabel =
        typeof this.theme.bg === 'function'
          ? this.theme.bg('selectedBg', this.theme.fg('text', rawLabel))
          : this.theme.style(rawLabel, { bg: 'selectedBg', fg: 'text' });
      const innerWidth = Math.max(0, width - 2);
      const pill = truncateToWidth(styledLabel, innerWidth, '');
      const pillWidth = visibleWidth(pill);
      if (pillWidth > 0) {
        const column = 1 + Math.max(0, Math.floor((innerWidth - pillWidth) / 2));
        const lastIdx = body.length - 1;
        body[lastIdx] = compositeTuiLine(body[lastIdx]!, pill, column, pillWidth, width);
        this.scrollToEndRect = {
          row: this.header.length + lastIdx,
          column,
          width: pillWidth,
        };
      } else {
        this.scrollToEndRect = undefined;
      }
    } else {
      this.scrollToEndRect = undefined;
    }

    return [...this.header, ...body, ...this.footer];
  }

  invalidate(): void {
    this.lastSignature = '';
    this.bodyDirty = true;
    this.body.invalidate();
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
  }
}

interface ToggleableComponent extends Component {
  readonly id: string;
  setHover(value: boolean): void;
  toggle(): void;
}

function isToggleable(component: Component): component is ToggleableComponent {
  return typeof (component as ToggleableComponent).toggle === 'function';
}

/**
 * Renders the child agent's thinking trace in Pi's `AssistantMessageComponent` style:
 * italic `thinkingText` color, expanded by default when thinking text is present,
 * and collapsible via `t` or mouse click.
 */
class ThinkingSection implements ToggleableComponent {
  readonly id: string;
  private hover = false;
  private cachedMarkdownText = '';
  private cachedMarkdownWidth = 0;
  private cachedMarkdownLines: string[] = [];
  private cachedFullKey = '';
  private cachedFullLines: string[] = [];

  constructor(
    private readonly theme: Theme,
    private readonly mdTheme: MarkdownTheme,
    id: string,
    private thinking: string,
    private elapsedText: string,
    private activelyThinking: boolean,
    private status: string,
    private expanded: boolean,
    private readonly onToggle: (value: boolean) => void,
  ) {
    this.id = id;
  }

  update(
    thinking: string,
    elapsedText: string,
    activelyThinking: boolean,
    status: string,
    expanded: boolean,
  ): void {
    this.thinking = thinking;
    this.elapsedText = elapsedText;
    this.activelyThinking = activelyThinking;
    this.status = status;
    this.expanded = expanded;
  }

  setHover(value: boolean): void {
    this.hover = value;
  }

  toggle(): void {
    this.expanded = !this.expanded;
    this.onToggle(this.expanded);
  }

  render(width: number): string[] {
    const fullKey = `${width}|${this.expanded}|${this.hover}|${this.activelyThinking}|${this.status}|${this.elapsedText}|${this.thinking.length}`;
    if (fullKey === this.cachedFullKey) {
      return this.cachedFullLines;
    }

    const marker = this.activelyThinking ? '●' : this.status === 'queued' ? '◷' : this.expanded ? '▼' : '▶';
    if (!this.thinking) {
      const label = themeItalic(
        this.theme,
        this.theme.fg('thinkingText', `${marker} ${this.activelyThinking ? 'Thinking…' : 'Thought'} · ${this.elapsedText}`),
      );
      this.cachedFullLines = new Text(label, 1, 0).render(width);
      this.cachedFullKey = fullKey;
      return this.cachedFullLines;
    }
    const hint = this.theme.fg('dim', this.expanded ? ' (t/click to hide)' : ' (t/click to expand)');
    const headerRaw = `${marker} ${this.activelyThinking ? 'Thinking' : 'Thought'} · ${this.elapsedText}`;
    const headerStyled = this.hover
      ? this.theme.style(headerRaw, { fg: 'text' })
      : themeItalic(this.theme, this.theme.fg('thinkingText', headerRaw));
    const headerLines = new Text(`${headerStyled}${hint}`, 1, 0).render(width);
    if (!this.expanded) {
      this.cachedFullLines = headerLines;
      this.cachedFullKey = fullKey;
      return this.cachedFullLines;
    }
    if (this.thinking !== this.cachedMarkdownText || width !== this.cachedMarkdownWidth) {
      this.cachedMarkdownLines = new Markdown(this.thinking.replace(/\r/g, ''), 1, 0, this.mdTheme, {
        color: (text) => this.theme.fg('thinkingText', text),
        italic: true,
      }).render(width);
      this.cachedMarkdownText = this.thinking;
      this.cachedMarkdownWidth = width;
    }
    this.cachedFullLines = [...headerLines, ...this.cachedMarkdownLines];
    this.cachedFullKey = fullKey;
    return this.cachedFullLines;
  }

  invalidate(): void {
    this.cachedFullKey = '';
    this.cachedMarkdownWidth = 0;
  }
}

/**
 * Renders a single top-level tool execution inside a themed `Box`, matching
 * Pi's `ToolExecutionComponent` (`toolPendingBg`, `toolErrorBg`, `toolSuccessBg`).
 */
class ToolExecutionBox implements ToggleableComponent {
  readonly id: string;
  private hover = false;
  private cachedKey = '';
  private cachedLines: string[] = [];

  constructor(
    private readonly theme: Theme,
    id: string,
    private tool: ToolRecord,
    private nestedCalls: readonly ToolRecord[],
    private expanded: boolean,
    private readonly onToggle: (value: boolean) => void,
  ) {
    this.id = id;
  }

  update(tool: ToolRecord, nestedCalls: readonly ToolRecord[], expanded: boolean): void {
    this.tool = tool;
    this.nestedCalls = nestedCalls;
    this.expanded = expanded;
  }

  setHover(value: boolean): void {
    this.hover = value;
  }

  toggle(): void {
    this.expanded = !this.expanded;
    this.onToggle(this.expanded);
  }

  render(width: number): string[] {
    const isRunningTimerTool =
      this.tool.status === 'running' && (this.tool.name === 'bash' || this.tool.name === 'codemode');
    const elapsedBucket = isRunningTimerTool ? Math.floor((Date.now() - this.tool.startedAt) / 100) : 0;
    const lastNested = this.nestedCalls[this.nestedCalls.length - 1];
    const key = `${width}|${this.expanded}|${this.tool.status}|${this.tool.output?.length ?? 0}|${this.tool.durationMs ?? ''}|${this.nestedCalls.length}|${lastNested?.status ?? ''}|${lastNested?.durationMs ?? ''}|${elapsedBucket}`;
    if (key === this.cachedKey) {
      return this.cachedLines;
    }
    const bgColor =
      this.tool.status === 'running'
        ? 'toolPendingBg'
        : this.tool.status === 'error'
          ? 'toolErrorBg'
          : 'toolSuccessBg';
    const box = new Box(1, 0, (t) => themeBg(this.theme, bgColor, t));
    const content = formatToolBoxText(this.tool, this.nestedCalls, this.theme, this.expanded);
    box.addChild(new Text(content, 0, 0));
    this.cachedLines = box.render(width);
    this.cachedKey = key;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedKey = '';
  }
}
