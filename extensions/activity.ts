import { Container, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { ChildSessionRecord } from './shell.js';
import type { ShellRecord } from './types.js';

const RESET = '\x1b[0m';
const DARK_BG = '\x1b[48;2;20;20;22m';
const PEACH_BG = '\x1b[48;2;254;180;120m\x1b[38;2;15;15;18m\x1b[1m';
const BORDER_FG = '\x1b[38;2;70;70;75m';
const BOLD_WHITE = '\x1b[1m\x1b[38;2;250;250;250m';
const DIM_GRAY = '\x1b[38;2;120;120;130m';
const MUTED_TEXT = '\x1b[38;2;200;200;210m';
const PURPLE = '\x1b[38;2;168;85;247m';
const YELLOW = '\x1b[38;2;234;179;8m';
const EXPLORED_GRAY = '\x1b[38;2;160;160;170m';
const GREEN = '\x1b[38;2;74;222;128m';
const RED = '\x1b[38;2;248;113;113m';
const MAX_VISIBLE_ROWS = 7;
const DETAIL_REFRESH_INTERVAL_MS = 200;

type ActivityItem = { kind: 'subagent'; value: ChildSessionRecord } | { kind: 'shell'; value: ShellRecord };

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusLabel(status: string): string {
  if (status === 'running') return 'Running';
  if (status === 'completed') return 'Done';
  if (status === 'cancelled') return 'Stopped';
  return 'Failed';
}

function opaqueLine(content: string, width: number): string {
  const innerWidth = Math.max(0, width - 1);
  const clipped = visibleWidth(content) > innerWidth ? truncateToWidth(content, innerWidth, '…') : content;
  return `${BORDER_FG}│${RESET}${DARK_BG}${clipped}${' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}${RESET}`;
}

function rowLine(left: string, right: string, selected: boolean, width: number): string {
  const innerWidth = Math.max(0, width - 1);
  const rightPad = `${right} `;
  const maxLeft = Math.max(0, innerWidth - visibleWidth(rightPad) - 2);
  const clippedLeft = visibleWidth(left) > maxLeft ? truncateToWidth(left, maxLeft, '…') : left;
  const padding = Math.max(1, innerWidth - visibleWidth(clippedLeft) - visibleWidth(rightPad) - 2);
  if (selected) return `${BORDER_FG}│${RESET}${PEACH_BG} ${clippedLeft}${' '.repeat(padding)}${rightPad}${RESET}`;
  return `${BORDER_FG}│${RESET}${DARK_BG} ${MUTED_TEXT}${clippedLeft}${RESET}${DARK_BG}${' '.repeat(padding)}${DIM_GRAY}${rightPad}${RESET}`;
}

function agentName(agent: string): string {
  return agent.length ? `${agent[0]!.toUpperCase()}${agent.slice(1)}` : 'Subagent';
}

function toolCounts(tools: ChildSessionRecord['tools']): { reads: number; searches: number; other: number } {
  let reads = 0;
  let searches = 0;
  let other = 0;
  for (const tool of tools) {
    if (tool.name === 'read') reads++;
    else if (tool.name === 'grep' || tool.name === 'find' || tool.name === 'web_search' || tool.name === 'glob') searches++;
    else other++;
  }
  return { reads, searches, other };
}

function exploredText(child: ChildSessionRecord): string {
  const counts = toolCounts(child.tools);
  const parts = [`${counts.reads} ${counts.reads === 1 ? 'read' : 'reads'}`, `${counts.searches} ${counts.searches === 1 ? 'search' : 'searches'}`];
  if (counts.other) parts.push(`${counts.other} ${counts.other === 1 ? 'tool' : 'tools'}`);
  return parts.join(', ');
}

class ActivityBody extends Container {
  constructor(private entries: Component[] = []) { super(); this.replace(); }
  setEntries(entries: Component[]): void { this.entries = entries; this.replace(); }
  private replace(): void { this.clear(); for (const entry of this.entries) this.addChild(entry); }
}

class GroupContent implements Component {
  readonly id: string;
  private hover = false;
  constructor(id: string, private readonly lines: string[], private expanded: boolean, private readonly onToggle: (value: boolean) => void) { this.id = id; }
  setHover(value: boolean): void { this.hover = value; }
  toggle(): void { this.expanded = !this.expanded; this.onToggle(this.expanded); }
  render(_width: number): string[] {
    const lines = this.expanded ? this.lines : this.lines.slice(0, 1);
    return lines.map((line, index) => opaqueLine(index === 0 && this.hover ? `\x1b[38;2;245;245;245m${line}${RESET}` : line, _width));
  }
  invalidate(): void {}
}

export interface ActivityStore {
  shells(): ShellRecord[];
  children(): ChildSessionRecord[];
  cancel(id: string): void;
  close(): void;
}

export class ActivityDocument implements Component, Focusable {
  private body = new ActivityBody();
  private detailScrollTop = 0;
  private detailBodyHeight = 0;
  private detailContentHeight = 0;
  private content: Component[] = [];
  private expanded = new Map<string, boolean>();
  private hoveredGroup?: string;
  private _focused = true;
  private lastSignature = '';
  private renderWidth = 80;
  private activeTab: 'subagents' | 'shell' = 'subagents';
  private showInactive = false;
  private selectedIndex = 0;
  private detailKey?: string;
  private actionNotice?: string;
  private refreshTimer: NodeJS.Timeout;

  constructor(private readonly tui: TUI, private readonly theme: Theme, private readonly store: ActivityStore) {
    this.refreshTimer = setInterval(() => {
      this.lastSignature = '';
      this.tui.requestRender();
    }, DETAIL_REFRESH_INTERVAL_MS);
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }

  private items(): ActivityItem[] {
    const values: ActivityItem[] = this.activeTab === 'subagents'
      ? this.store.children().map((value) => ({ kind: 'subagent', value }))
      : this.store.shells().map((value) => ({ kind: 'shell', value }));
    if (this.showInactive) return values;
    const running = values.filter((item) => item.value.status === 'running');
    return running.length ? running : values;
  }

  private selectedItem(): ActivityItem | undefined { return this.items()[this.selectedIndex]; }

  private scrollDetail(delta: number): void {
    this.detailScrollTop = Math.max(0, Math.min(Math.max(0, this.detailContentHeight - this.detailBodyHeight), this.detailScrollTop + delta));
  }

  private itemId(item: ActivityItem): string { return item.kind === 'subagent' ? item.value.sessionId : item.value.shellID; }

  private selectedId(item: ActivityItem | undefined): string | undefined { return item ? `${item.kind}:${this.itemId(item)}` : undefined; }

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

    if (matchesKey(data, 'escape') || data === 'q') { this.store.close(); return; }
    if (matchesKey(data, 'up')) {
      if (this.selectedIndex === 0 || items.length === 0) { this.store.close(); return; }
      this.selectedIndex--;
    } else if (matchesKey(data, 'down')) {
      if (items.length) this.selectedIndex = Math.min(items.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, 'left') || matchesKey(data, 'right') || matchesKey(data, 'tab')) {
      this.activeTab = this.activeTab === 'subagents' ? 'shell' : 'subagents';
      this.selectedIndex = 0;
    } else if (matchesKey(data, 'enter') || data === ' ') this.enterDetail();
    else if (matchesKey(data, 'ctrl+a')) { this.showInactive = !this.showInactive; this.selectedIndex = 0; }
    else if (matchesKey(data, 'ctrl+d') || data === 'x') this.interruptSelected();
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
      else if (this.items().length) this.selectedIndex = Math.max(0, Math.min(this.items().length - 1, this.selectedIndex + (delta < 0 ? 1 : -1)));
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
      if (event.y < this.header.length && event.x < 20) { this.detailKey = undefined; this.lastSignature = ''; this.tui.requestRender(); return { handled: true, render: true }; }
      const group = this.groupAt(event.y - this.header.length + this.detailScrollTop);
      if (group) { group.toggle(); this.lastSignature = ''; this.tui.requestRender(); return { handled: true, render: true }; }
      return undefined;
    }

    if (event.y === 0) {
      if (event.x < 14) this.activeTab = 'subagents';
      else if (event.x < 25) this.activeTab = 'shell';
      else if (event.x >= this.renderWidth - 6) this.store.close();
      this.selectedIndex = 0;
      this.lastSignature = '';
      this.tui.requestRender();
      return { handled: true, render: true };
    }
    const row = event.y - this.rowStart;
    if (row >= 0 && row < this.visibleItems.length) {
      const index = this.visibleStart + row;
      this.selectedIndex = index;
      if ((event.clickCount ?? 1) > 1) this.enterDetail(this.visibleItems[row]);
      else this.lastSignature = '';
      this.tui.requestRender();
      return { handled: true, render: true };
    }
    return undefined;
  }

  private visibleItems: ActivityItem[] = [];
  private visibleStart = 0;
  private rowStart = 2;
  private header: string[] = [];
  private footer: string[] = [];

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
      for (const line of prompt.split('\n')) lines.push(new Text(`${PURPLE}│${RESET} ${MUTED_TEXT}${line}${RESET}`, 2, 0));
      lines.push(new Text('', 0, 0));
      const thoughtKey = `thought:${child.sessionId}`;
      const elapsed = Math.max(0, (child.completedAt ?? Date.now()) - child.startedAt);
      const elapsedText = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
      const thoughtLines = [`  ${YELLOW}${child.status === 'running' ? '●' : (this.expanded.get(thoughtKey) ? '−' : '+')} Thought · ${elapsedText}${RESET}`];
      if (child.thinking) thoughtLines.push(...child.thinking.split('\n').map((line) => `    ${DIM_GRAY}${line}${RESET}`));
      lines.push(new GroupContent(thoughtKey, thoughtLines, this.expanded.get(thoughtKey) ?? false, (value) => this.expanded.set(thoughtKey, value)));
      lines.push(new Text('', 0, 0));

      const exploredKey = `explore:${child.sessionId}`;
      const exploredLines = [`  ${EXPLORED_GRAY}${child.status === 'running' ? '→ Exploring' : (this.expanded.get(exploredKey) ? '▼ Explored' : '→ Explored')}: ${exploredText(child)}${RESET}`];
      for (const tool of child.tools) {
        const args = JSON.stringify(tool.input ?? {}).replace(/\s+/g, ' ').slice(0, 100);
        exploredLines.push(`    ${DIM_GRAY}${tool.name}(${args})${tool.status === 'running' ? ' …' : ''}${RESET}`);
        if (tool.output) for (const outputLine of tool.output.split('\n').slice(0, 6)) exploredLines.push(`      ${MUTED_TEXT}${outputLine}${RESET}`);
      }
      lines.push(new GroupContent(exploredKey, exploredLines, this.expanded.get(exploredKey) ?? false, (value) => this.expanded.set(exploredKey, value)));
      if (child.status === 'running') lines.push(new Text(`  ${GREEN}● Active: ${child.tools.at(-1)?.name ?? 'Preparing subagent'}${RESET}`, 2, 0));
      if (child.result) for (const line of [`  ${BOLD_WHITE}Synthesis Findings:${RESET}`, ...child.result.split('\n').map((value) => `  ${MUTED_TEXT}${value}${RESET}`)]) lines.push(new Text(line, 2, 0));
      if (child.error) lines.push(new Text(`  ${RED}Error: ${child.error}${RESET}`, 2, 0));
    } else {
      const shell = item.value;
      lines.push(new Text(`${PURPLE}│${RESET} ${BOLD_WHITE}$ ${shell.command}${RESET}`, 2, 0));
      lines.push(new Text('', 0, 0));
      lines.push(new Text(`  ${DIM_GRAY}Output${RESET}`, 2, 0));
      for (const line of shell.output.split('\n').slice(-100)) lines.push(new Text(`    ${MUTED_TEXT}${line}${RESET}`, 2, 0));
      if (shell.error) lines.push(new Text(`  ${RED}${shell.error}${RESET}`, 2, 0));
    }
    return lines;
  }

  private refresh(): void {
    const children = this.store.children();
    const shells = this.store.shells();
    const detailItem = this.detailKey ? this.findItem(this.detailKey) : undefined;
    const signature = JSON.stringify([
      this.renderWidth, this.detailKey, this.activeTab, this.showInactive, this.selectedIndex, this.actionNotice,
      children.map((c) => [c.sessionId, c.status, c.tools.length, c.thinking?.length, c.result?.length, c.tools.map((t) => [t.name, t.status, t.output?.length])]),
      shells.map((s) => [s.shellID, s.status, s.output.length]),
    ]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.content = [];
    this.renderWidth = Math.max(1, this.renderWidth);

    if (this.detailKey && !detailItem) this.detailKey = undefined;
    if (detailItem) {
      this.content = this.buildDetailContent(detailItem);
      this.body.setEntries(this.content);
      const active = detailItem.value.status === 'running';
      const label = detailItem.kind === 'subagent' ? detailItem.value.description : detailItem.value.command;
      const status = active ? `${GREEN}● Running${RESET}` : detailItem.value.status === 'completed' ? `${DIM_GRAY}Done${RESET}` : `${RED}${statusLabel(detailItem.value.status)}${RESET}`;
      const rightPad = status;
      const left = `  ${BOLD_WHITE}← Back (esc/←)${RESET}   ${DIM_GRAY}${label}${RESET}`;
      const padding = Math.max(1, this.renderWidth - visibleWidth(left) - visibleWidth(rightPad) - 2);
      this.header = [opaqueLine(`${left}${' '.repeat(padding)}${rightPad} `, this.renderWidth), opaqueLine('', this.renderWidth)];
      this.footer = [opaqueLine(`  ${BOLD_WHITE}back${RESET} ${DIM_GRAY}esc/←${RESET}  ${BOLD_WHITE}scroll${RESET} ${DIM_GRAY}wheel/↑/↓${RESET}  ${BOLD_WHITE}thought${RESET} ${DIM_GRAY}t/click${RESET}  ${BOLD_WHITE}tools${RESET} ${DIM_GRAY}e/click${RESET}  ${BOLD_WHITE}interrupt${RESET} ${DIM_GRAY}ctrl+d${RESET}`, this.renderWidth)];
      return;
    }

    this.body.setEntries([]);
    const allChildren = children;
    const allShells = shells;
    if (this.activeTab === 'subagents' && !allChildren.length && allShells.length) this.activeTab = 'shell';
    else if (this.activeTab === 'shell' && !allShells.length && allChildren.length) this.activeTab = 'subagents';
    const items = this.items();
    this.selectedIndex = items.length ? Math.max(0, Math.min(this.selectedIndex, items.length - 1)) : 0;
    const rows = Math.max(1, Math.min(MAX_VISIBLE_ROWS, (process.stdout.rows || 24) - 4));
    this.visibleStart = Math.max(0, Math.min(this.selectedIndex - rows + 1, Math.max(0, items.length - rows)));
    this.visibleItems = items.slice(this.visibleStart, this.visibleStart + rows);
    const active = items.filter((item) => item.value.status === 'running').length;
    const subagentsLabel = this.activeTab === 'subagents' ? `${BOLD_WHITE}Subagents${RESET}` : `${DIM_GRAY}Subagents${RESET}`;
    const shellLabel = this.activeTab === 'shell' ? `${BOLD_WHITE}Shell${RESET}` : `${DIM_GRAY}Shell${RESET}`;
    const left = `  ${subagentsLabel}  ${shellLabel}`;
    const right = `${DIM_GRAY}esc  ${RESET}`;
    const padding = Math.max(0, this.renderWidth - visibleWidth(left) - visibleWidth(right) - 1);
    this.header = [opaqueLine(`${left}${' '.repeat(padding)}${right}`, this.renderWidth), opaqueLine('', this.renderWidth)];
    this.footer = [opaqueLine(`  ${BOLD_WHITE}interrupt${RESET} ${DIM_GRAY}ctrl+d${RESET}  ${BOLD_WHITE}${this.showInactive ? 'hide inactive' : 'show inactive'}${RESET} ${DIM_GRAY}ctrl+a${RESET}  ${BOLD_WHITE}open${RESET} ${DIM_GRAY}enter${RESET}  ${BOLD_WHITE}tabs${RESET} ${DIM_GRAY}←/→${RESET}`, this.renderWidth)];

    const panelHeight = Math.min(process.stdout.rows || 24, Math.max(10, rows + 5));
    const listLines: string[] = [...this.header];
    this.rowStart = listLines.length;
    for (let i = 0; i < rows; i++) {
      const item = this.visibleItems[i];
      if (!item) { listLines.push(opaqueLine('', this.renderWidth)); continue; }
      const label = item.kind === 'subagent' ? `${agentName(item.value.agent)}: ${item.value.description}` : item.value.command.split('\n', 1)[0]!;
      const status = item.value.status === 'running' ? `${GREEN}Running${RESET}` : statusLabel(item.value.status);
      listLines.push(rowLine(label, status, this.visibleStart + i === this.selectedIndex, this.renderWidth));
    }
    if (!items.length) listLines[this.rowStart] = opaqueLine(`  ${DIM_GRAY}No ${this.activeTab === 'subagents' ? 'subagents' : 'shell processes'}${this.showInactive ? '' : ' running'}.${RESET}`, this.renderWidth);
    while (listLines.length < panelHeight - 1) listLines.push(opaqueLine(this.actionNotice ? `  ${RED}${this.actionNotice}${RESET}` : '', this.renderWidth));
    listLines.push(this.footer[0]!);
    this.header = listLines;
  }

  render(width: number): string[] {
    this.renderWidth = width;
    this.refresh();
    if (!this.detailKey) return this.header;
    const height = Math.max(10, process.stdout.rows || 24);
    const bodyHeight = Math.max(1, height - this.header.length - this.footer.length);
    const rendered = this.body.render(width);
    this.detailBodyHeight = bodyHeight;
    this.detailContentHeight = rendered.length;
    this.detailScrollTop = Math.max(0, Math.min(this.detailScrollTop, Math.max(0, rendered.length - bodyHeight)));
    const body = rendered.slice(this.detailScrollTop, this.detailScrollTop + bodyHeight).map((line) => opaqueLine(line, width));
    while (body.length < bodyHeight) body.push(opaqueLine('', width));
    return [...this.header, ...body, ...this.footer];
  }

  invalidate(): void { this.lastSignature = ''; this.body.invalidate(); }
  dispose(): void { clearInterval(this.refreshTimer); }
}
