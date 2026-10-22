import { Container, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { ChildSessionRecord } from './subagent.js';
import type { ShellRecord } from './types.js';

const MAX_VISIBLE_ROWS = 7;
const DETAIL_REFRESH_INTERVAL_MS = 200;

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

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusLabel(status: string): string {
  if (status === 'running') return 'Running';
  if (status === 'completed') return 'Done';
  if (status === 'cancelled') return 'Stopped';
  return 'Failed';
}

function agentName(agent: string): string {
  if (!agent.length) return 'Subagent';
  return `${agent[0]!.toUpperCase()}${agent.slice(1)}`;
}

function toolCounts(tools: { name: string }[]): { reads: number; searches: number; other: number } {
  let reads = 0;
  let searches = 0;
  let other = 0;
  for (const tool of tools) {
    if (tool.name === 'read') reads++;
    else if (tool.name === 'grep' || tool.name === 'find' || tool.name === 'ls') searches++;
    else other++;
  }
  return { reads, searches, other };
}

/**
 * The activity dock.
 *
 * It lists the running commands and child agents, and opens a detail view with
 * the prompt, the thinking trace, and the tool history of a child. All colors
 * come from the active Pi theme, so the dock follows the terminal's theme.
 */
export class ActivityDocument implements Component, Focusable {
  private body = new Container();
  private detailScrollTop = 0;
  private detailBodyHeight = 0;
  private detailContentHeight = 0;
  private content: Component[] = [];
  private expanded = new Map<string, boolean>();
  private hoveredGroup?: string;
  private _focused = true;
  private lastSignature = '';
  private renderWidth = 80;
  private activeTab: ActivityTab = 'subagents';
  private tabManuallySelected = false;
  private showInactive = false;
  private selectedIndex = 0;
  private detailKey?: string;
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
      this.lastSignature = '';
      this.tui.requestRender();
    }, DETAIL_REFRESH_INTERVAL_MS);
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
  }

  private items(): ActivityItem[] {
    const values: ActivityItem[] =
      this.activeTab === 'subagents'
        ? this.store.children().map((value) => ({ kind: 'subagent', value }))
        : this.store.shells().map((value) => ({ kind: 'shell', value }));
    if (this.showInactive) return values;
    const running = values.filter((item) => item.value.status === 'running');
    return running.length ? running : values;
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
        this.lastSignature = '';
      } else if (matchesKey(data, 'up')) this.scrollDetail(-1);
      else if (matchesKey(data, 'down')) this.scrollDetail(1);
      else if (matchesKey(data, 'pageUp')) this.scrollDetail(-8);
      else if (matchesKey(data, 'pageDown')) this.scrollDetail(8);
      else if (matchesKey(data, 'ctrl+d') || data === 'x') this.interruptSelected();
      else if (data === 't' || data === 'T') this.toggleGroup('thought:');
      else if (data === 'e' || data === 'E' || data === 'o' || data === 'O') this.toggleGroup('explore:');
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
    else if (matchesKey(data, 'ctrl+a')) {
      this.showInactive = !this.showInactive;
      this.selectedIndex = 0;
    } else if (matchesKey(data, 'ctrl+d') || data === 'x') this.interruptSelected();
    this.lastSignature = '';
    this.tui.requestRender();
  }

  private interruptSelected(): void {
    const selected = this.detailKey ? this.findItem(this.detailKey) : this.selectedItem();
    if (!selected || selected.value.status !== 'running') return;
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

  private toggleGroup(prefix: string): void {
    if (!this.detailKey) return;
    const key = `${prefix}${this.detailKey.slice(this.detailKey.indexOf(':') + 1)}`;
    this.expanded.set(key, !(this.expanded.get(key) ?? false));
    this.lastSignature = '';
  }

  handleMouse(event: TuiMouseEvent): { handled?: boolean; render?: boolean } | undefined {
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 1;
      if (this.detailKey) this.scrollDetail(-delta);
      else if (this.items().length) {
        this.selectedIndex = Math.max(0, Math.min(this.items().length - 1, this.selectedIndex + (delta < 0 ? 1 : -1)));
      }
      this.lastSignature = '';
      this.tui.requestRender();
      return { handled: true, render: true };
    }
    if (event.type !== 'click' || event.button !== 'left') {
      if (event.type === 'move' && this.detailKey) this.updateHoveredGroup(event.y - this.header.length + this.detailScrollTop);
      return undefined;
    }

    if (this.detailKey) {
      if (event.y >= this.header.length + this.detailBodyHeight) return undefined;
      if (event.y < this.header.length && event.x < 20) {
        this.detailKey = undefined;
        this.lastSignature = '';
        this.tui.requestRender();
        return { handled: true, render: true };
      }
      const group = this.groupAt(event.y - this.header.length + this.detailScrollTop);
      if (group) {
        group.toggle();
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
    if (this.hoveredGroup) {
      const previous = this.content.find((entry) => entry instanceof GroupContent && entry.id === this.hoveredGroup);
      if (previous instanceof GroupContent) previous.setHover(false);
    }
    group?.setHover(true);
    this.hoveredGroup = group?.id;
    this.tui.requestRender();
  }

  private groupAt(target: number): GroupContent | undefined {
    let row = 0;
    for (const item of this.content) {
      const height = item.render(this.renderWidth).length;
      if (target >= row && target < row + height && item instanceof GroupContent) return item;
      row += height;
    }
    return undefined;
  }

  private buildDetailContent(item: ActivityItem): Component[] {
    const lines: Component[] = [];
    if (item.kind === 'subagent') {
      const child = item.value;
      const prompt = child.lastPrompt || 'Subagent task';
      for (const line of prompt.split('\n')) {
        lines.push(new Text(`${this.theme.fg('accent', '│')} ${this.theme.fg('text', line)}`, 2, 0));
      }
      lines.push(new Text('', 0, 0));

      const thoughtKey = `thought:${child.sessionId}`;
      const elapsed = Math.max(0, (child.completedAt ?? Date.now()) - child.startedAt);
      const elapsedText = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
      const marker = child.status === 'running' ? '●' : this.expanded.get(thoughtKey) ? '−' : '+';
      const thoughtLines = [`  ${this.theme.fg('warning', `${marker} Thought · ${elapsedText}`)}`];
      if (child.thinking) {
        for (const line of child.thinking.split('\n')) {
          thoughtLines.push(`    ${this.theme.fg('dim', line)}`);
        }
      }
      lines.push(
        new GroupContent(
          this.theme,
          thoughtKey,
          thoughtLines,
          this.expanded.get(thoughtKey) ?? false,
          (value) => this.expanded.set(thoughtKey, value),
        ),
      );
      lines.push(new Text('', 0, 0));

      const exploredKey = `explore:${child.sessionId}`;
      const counts = toolCounts(child.tools);
      const summary = `${counts.reads} ${counts.reads === 1 ? 'read' : 'reads'}, ${counts.searches} ${counts.searches === 1 ? 'search' : 'searches'}`;
      const exploreMarker = child.status === 'running' ? '→ Exploring' : this.expanded.get(exploredKey) ? '▼ Explored' : '→ Explored';
      const exploredLines = [`  ${this.theme.fg('muted', `${exploreMarker}: ${summary}`)}`];
      for (const tool of child.tools) {
        const args = JSON.stringify(tool.input ?? {}).replace(/\s+/g, ' ').slice(0, 100);
        exploredLines.push(
          `    ${this.theme.fg('dim', `${tool.name}(${args})${tool.status === 'running' ? ' …' : ''}`)}`,
        );
        if (tool.output) {
          for (const outputLine of tool.output.split('\n').slice(0, 6)) {
            exploredLines.push(`      ${this.theme.fg('text', outputLine)}`);
          }
        }
      }
      lines.push(
        new GroupContent(
          this.theme,
          exploredKey,
          exploredLines,
          this.expanded.get(exploredKey) ?? false,
          (value) => this.expanded.set(exploredKey, value),
        ),
      );
      if (child.status === 'running') {
        lines.push(new Text(`  ${this.theme.fg('success', `● Active: ${child.tools.at(-1)?.name ?? 'Preparing subagent'}`)}`, 2, 0));
      }
      if (child.result) {
        lines.push(new Text(`  ${this.theme.bold('Synthesis Findings:')}`, 2, 0));
        for (const line of child.result.split('\n')) {
          lines.push(new Text(`  ${this.theme.fg('text', line)}`, 2, 0));
        }
      }
      if (child.error) lines.push(new Text(`  ${this.theme.fg('error', `Error: ${child.error}`)}`, 2, 0));
    } else {
      const shell = item.value;
      lines.push(new Text(`${this.theme.fg('accent', '│')} ${this.theme.bold(`$ ${shell.command}`)}`, 2, 0));
      lines.push(new Text('', 0, 0));
      lines.push(new Text(`  ${this.theme.fg('dim', 'Output')}`, 2, 0));
      for (const line of shell.output.split('\n').slice(-100)) {
        lines.push(new Text(`    ${this.theme.fg('text', line)}`, 2, 0));
      }
      if (shell.error) lines.push(new Text(`  ${this.theme.fg('error', shell.error)}`, 2, 0));
    }
    return lines;
  }

  private refresh(): void {
    const children = this.store.children();
    const shells = this.store.shells();
    const detailItem = this.detailKey ? this.findItem(this.detailKey) : undefined;
    const signature = JSON.stringify([
      this.renderWidth,
      this.detailKey,
      this.activeTab,
      this.showInactive,
      this.selectedIndex,
      this.actionNotice,
      children.map((c) => [c.sessionId, c.status, c.tools.length, c.thinking?.length, c.result?.length]),
      shells.map((s) => [s.shellID, s.status, s.output.length]),
    ]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.content = [];
    this.renderWidth = Math.max(1, this.renderWidth);

    if (this.detailKey && !detailItem) this.detailKey = undefined;
    if (detailItem) {
      this.content = this.buildDetailContent(detailItem);
      this.body.clear();
      for (const entry of this.content) this.body.addChild(entry);
      const active = detailItem.value.status === 'running';
      const label =
        detailItem.kind === 'subagent' ? detailItem.value.description : detailItem.value.command;
      const status = active
        ? this.theme.fg('success', '● Running')
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
        item.value.status === 'running' ? this.theme.fg('success', 'Running') : statusLabel(item.value.status);
      listLines.push(this.row(label, status, this.visibleStart + i === this.selectedIndex));
    }
    if (!items.length) {
      listLines[this.rowStart] = this.line(
        `  ${this.theme.fg('dim', `No ${this.activeTab === 'subagents' ? 'subagents' : 'shell processes'}${this.showInactive ? '' : ' running'}.`)}`,
      );
    }
    while (listLines.length < panelHeight - 1) {
      listLines.push(this.line(this.actionNotice ? `  ${this.theme.fg('error', this.actionNotice)}` : ''));
    }
    listLines.push(
      this.line(
        `  ${this.theme.bold('interrupt')} ${this.theme.fg('dim', 'ctrl+d')}  ${this.theme.bold(this.showInactive ? 'hide inactive' : 'show inactive')} ${this.theme.fg('dim', 'ctrl+a')}  ${this.theme.bold('open')} ${this.theme.fg('dim', 'enter')}  ${this.theme.bold('tabs')} ${this.theme.fg('dim', '←/→')}`,
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
    if (!this.detailKey) return this.header;
    const height = Math.max(10, this.tui.terminal.rows || 24);
    const bodyHeight = Math.max(1, height - this.header.length - this.footer.length);
    const rendered = this.body.render(width);
    this.detailBodyHeight = bodyHeight;
    this.detailContentHeight = rendered.length;
    this.detailScrollTop = Math.max(0, Math.min(this.detailScrollTop, Math.max(0, rendered.length - bodyHeight)));
    const body = rendered
      .slice(this.detailScrollTop, this.detailScrollTop + bodyHeight)
      .map((line) => this.line(line));
    while (body.length < bodyHeight) body.push(this.line(''));
    return [...this.header, ...body, ...this.footer];
  }

  invalidate(): void {
    this.lastSignature = '';
    this.body.invalidate();
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
  }
}

/** A collapsible group of lines in the detail view. */
class GroupContent implements Component {
  readonly id: string;
  private hover = false;

  constructor(
    private readonly theme: Theme,
    id: string,
    private readonly lines: string[],
    private expanded: boolean,
    private readonly onToggle: (value: boolean) => void,
  ) {
    this.id = id;
  }

  setHover(value: boolean): void {
    this.hover = value;
  }

  toggle(): void {
    this.expanded = !this.expanded;
    this.onToggle(this.expanded);
  }

  render(width: number): string[] {
    const lines = this.expanded ? this.lines : this.lines.slice(0, 1);
    return lines.map((line, index) => {
      const content = index === 0 && this.hover ? this.theme.style(line, { fg: 'text' }) : line;
      const inner = Math.max(0, width - 1);
      const clipped = visibleWidth(content) > inner ? truncateToWidth(content, inner, '…') : content;
      return `${clipped}${' '.repeat(Math.max(0, inner - visibleWidth(clipped)))}`;
    });
  }

  invalidate(): void {}
}
