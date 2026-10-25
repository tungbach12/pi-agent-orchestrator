import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type ExtensionToolContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { JobRegistry } from './jobs.js';
import {
  agentSystemPrompt,
  EMPTY_COMPLETION_NUDGE,
  formatSubagentPrompt,
  FRESH_PROMPT,
  SUBAGENT_NO_TEXT,
  truncateSubagentOutput,
} from './prompts.js';
import { createReadOnlyGuard } from './read-only.js';
import { runReviewGate } from './review.js';
import {
  AGENT_EXCLUDED_TOOLS,
  AGENT_KINDS,
  AGENT_TOOLS,
  BASE_CHILD_TOOLS,
  isCodingAgent,
  isReadOnlyAgent,
  type AgentKind,
  type ChildRecord,
  type JobInfo,
  type ToolRecord,
} from './types.js';

/** Custom session entry that records which agent a child session belongs to. */
const CHILD_ENTRY = 'pi-agent-orchestrator.child';
const LEGACY_CHILD_ENTRY = 'pi-opencode-orchestrator.child';
const SUBAGENTS_ENTRY = 'pi-agent-orchestrator.subagents.v1';
const PERSISTED_SUBAGENT_LIMIT = 50;

/**
 * Stores child session files in a `subagents/` subdirectory next to the parent
 * session file so Pi's `/resume` (`SessionManager.list` and `SessionManager.listAll`)
 * and `pi -c` (`continueRecent`) only ever list main user sessions.
 */
export function childSessionDirForParent(parentSessionFile: string): string {
  return join(dirname(parentSessionFile), 'subagents');
}

/**
 * Moves any legacy child session `.jsonl` files that were previously written in
 * the top-level project session directory into the `subagents/` subdirectory so
 * `/resume` stays clean of subagent transcripts.
 */
export function relocateLegacyChildSessions(parentSessionFile: string): void {
  const parentDir = dirname(parentSessionFile);
  if (!existsSync(parentDir)) return;
  const subagentsDir = childSessionDirForParent(parentSessionFile);
  const parentBase = basename(parentSessionFile);
  let entries: string[];
  try {
    entries = readdirSync(parentDir);
  } catch {
    return;
  }
  for (const file of entries) {
    if (!file.endsWith('.jsonl') || file === parentBase) continue;
    const fullPath = join(parentDir, file);
    let head = '';
    try {
      const fd = openSync(fullPath, 'r');
      try {
        const buf = Buffer.alloc(4096);
        const bytes = readSync(fd, buf, 0, buf.length, 0);
        head = buf.toString('utf8', 0, bytes);
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    if (!head.includes(`"${CHILD_ENTRY}"`) && !head.includes(`"${LEGACY_CHILD_ENTRY}"`)) {
      continue;
    }
    try {
      mkdirSync(subagentsDir, { recursive: true });
      renameSync(fullPath, join(subagentsDir, file));
    } catch {
      // Ignore files currently locked by another process.
    }
  }
}

function normalizeSavedAgent(agent: unknown): AgentKind {
  if (typeof agent === 'string' && (AGENT_KINDS as readonly string[]).includes(agent)) {
    return agent as AgentKind;
  }
  return 'explore';
}

/** Reconstructs prompt, thinking, tool calls, and final result from a child session's JSONL entries. */
function extractTranscriptState(entries: any[]): {
  lastPrompt?: string;
  thinking?: string;
  thinkingDurationMs?: number;
  tools: ToolRecord[];
  result?: string;
  aborted?: boolean;
} {
  let lastPrompt: string | undefined;
  const thinkingBlocks: string[] = [];
  const tools: ToolRecord[] = [];
  const byCallId = new Map<string, ToolRecord>();
  let result: string | undefined;
  let firstMsgTs: number | undefined;
  let firstToolTs: number | undefined;
  let lastAssistantAborted = false;

  for (const entry of entries) {
    if (entry?.type !== 'message' || !entry.message) continue;
    const msg = entry.message;
    const ts = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now();
    if (msg.role === 'user') {
      firstMsgTs ??= ts;
      lastAssistantAborted = false;
      const text = Array.isArray(msg.content)
        ? msg.content
            .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
            .map((c: any) => c.text)
            .join('\n')
        : typeof msg.content === 'string'
          ? msg.content
          : '';
      if (text) {
        lastPrompt = text.replace(new RegExp(`^${FRESH_PROMPT}\\r?\\n+`), '');
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      firstMsgTs ??= ts;
      lastAssistantAborted =
        msg.stopReason === 'aborted' ||
        (msg.stopReason === 'error' &&
          typeof msg.errorMessage === 'string' &&
          /abort/i.test(msg.errorMessage));
      for (const part of msg.content) {
        if (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
          thinkingBlocks.push(part.thinking.trim());
        } else if (part?.type === 'toolCall' && typeof part.name === 'string') {
          firstToolTs ??= ts;
          const record: ToolRecord = {
            toolCallId: part.id,
            name: part.name,
            input: part.arguments,
            startedAt: ts,
            status: 'completed',
          };
          tools.push(record);
          if (part.id) byCallId.set(part.id, record);
        }
      }
      const textParts = msg.content
        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim())
        .map((part: any) => part.text.trim());
      if (textParts.length > 0) {
        result = textParts.join('\n\n');
      }
    } else if (msg.role === 'toolResult') {
      const record = msg.toolCallId ? byCallId.get(msg.toolCallId) : undefined;
      if (record) {
        record.completedAt = ts;
        record.durationMs =
          typeof msg.durationMs === 'number' ? msg.durationMs : Math.max(0, ts - record.startedAt);
        record.status = msg.isError ? 'error' : 'completed';
        record.details = msg.details;
        record.exitCode = msg.structuredContent?.exit_code ?? msg.structuredContent?.exitCode;
        const structuredOutput = msg.structuredContent?.output;
        const text = Array.isArray(msg.content)
          ? msg.content
              .filter((part: any) => part?.type === 'text')
              .map((part: any) => part.text)
              .join('\n')
          : '';
        if (typeof structuredOutput === 'string') record.output = structuredOutput;
        else if (text) record.output = text;
      }
      const nestedList = msg.nestedCalls?.calls;
      if (Array.isArray(nestedList) && msg.toolCallId) {
        for (const nested of nestedList) {
          if (!nested || typeof nested !== 'object') continue;
          tools.push({
            toolCallId: nested.id,
            parentToolCallId: msg.toolCallId,
            name: String(nested.name ?? nested.toolName ?? 'tool'),
            input: nested.arguments ?? nested.args ?? {},
            startedAt: ts,
            completedAt: ts,
            durationMs: typeof nested.durationMs === 'number' ? nested.durationMs : undefined,
            status: nested.isError ? 'error' : 'completed',
          });
        }
      }
    }
  }

  const thinking = thinkingBlocks.length > 0 ? thinkingBlocks.join('\n\n') : undefined;
  const thinkingDurationMs =
    thinking && firstMsgTs !== undefined && firstToolTs !== undefined && firstToolTs > firstMsgTs
      ? firstToolTs - firstMsgTs
      : undefined;

  return { lastPrompt, thinking, thinkingDurationMs, tools, result, aborted: lastAssistantAborted };
}

/** How deep a child session may nest another child session. */
const DEPTH_LIMIT = 1;

export interface ChildSessionRecord extends ChildRecord {
  parentSessionId: string;
  initialPrompt?: string;
  expectedOutput?: string;
  lastPrompt?: string;
  thinking?: string;
  /** True when stopped before completion and not yet surfaced/resumed on the parent's next turn. */
  interruptedNoticePending?: boolean;
  /** Index of the first tool call not yet reported in a completed subagent result. */
  unreportedToolStart?: number;
  /** True when reconstructed from persisted metadata without a live AgentSession bound yet. */
  needsResume?: boolean;
  /** Queued steering prompts injected while the child is queued or running. */
  pendingSteers?: string[];
  /** True until the child has been prompted for the first time. */
  fresh: boolean;
  run: (prompt: string, signal?: AbortSignal) => Promise<string>;
  abort: () => Promise<void>;
}

export interface SubagentEvents {
  changed?: (record: ChildSessionRecord) => void;
  /** Fired once the child acquires an execution slot. */
  started?: (record: ChildSessionRecord, info: JobInfo) => void;
  /** Fired once the child reached a terminal state. */
  completed?: (record: ChildSessionRecord, info: JobInfo) => void;
}

export type SpawnSubagentInput = {
  agent: AgentKind;
  description: string;
  prompt: string;
  expectedOutput?: string;
  review?: boolean;
  model?: string;
  sessionID?: string;
  background?: boolean;
};

const BUILTIN_CHILD_TOOL_SET = new Set<string>([...BASE_CHILD_TOOLS, 'powershell']);

/**
 * Inherits callable tools from the parent session (`ctx.tools`) and excludes:
 * 1. Built-in child tools (already registered natively in the child session)
 * 2. Role-excluded tools (`AGENT_EXCLUDED_TOOLS[agent]`)
 * 3. Non-read-only annotated tools (`readOnlyHint === false` or `destructiveHint === true`) for read-only roles
 */
function inheritedParentTools(ctx: ExtensionToolContext, agent: AgentKind): ToolDefinition[] {
  if (!Array.isArray(ctx.tools)) return [];
  const excluded = new Set<string>(AGENT_EXCLUDED_TOOLS[agent]);
  const readOnly = isReadOnlyAgent(agent);
  return ctx.tools
    .filter((tool) => {
      if (!tool?.name || BUILTIN_CHILD_TOOL_SET.has(tool.name) || excluded.has(tool.name)) {
        return false;
      }
      const annotations = (tool as { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }).annotations;
      if (readOnly && (annotations?.readOnlyHint === false || annotations?.destructiveHint === true)) {
        return false;
      }
      return true;
    })
    .map((tool) => ({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.constrainedSampling !== undefined ? { constrainedSampling: tool.constrainedSampling } : {}),
      ...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
      ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
      execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
    }));
}

/**
 * Resolves the child session's active tools, excluded tools, and forwarded parent tools:
 * - Inherits all built-in + parent tools
 * - Excludes `AGENT_EXCLUDED_TOOLS[agent]`
 */
export function resolveChildTools(
  ctx: ExtensionToolContext,
  agent: AgentKind,
  reviewerMode = false,
): { activeTools: string[]; excludeTools: string[]; customTools: ToolDefinition[] } {
  const customTools = reviewerMode ? [] : inheritedParentTools(ctx, agent);
  const excludeTools = [...AGENT_EXCLUDED_TOOLS[agent]];
  const excludedSet = new Set<string>(excludeTools);
  const activeTools = [
    ...AGENT_TOOLS[agent],
    ...customTools.map((tool) => tool.name),
  ].filter((name) => !excludedSet.has(name));
  return {
    activeTools: [...new Set(activeTools)],
    excludeTools,
    customTools,
  };
}
export class SubagentManager {
  private readonly children = new Map<string, ChildSessionRecord>();
  private readonly sessions = new Map<string, Awaited<ReturnType<typeof createAgentSession>>['session']>();
  private readonly running = new Map<string, AbortController>();
  private readonly depths = new Map<string, number>();
  private readonly jobs: JobRegistry;
  private events: SubagentEvents;
  private readonly createSession: typeof createAgentSession;
  private persist?: (customType: string, data: unknown) => void;

  constructor(
    jobs: JobRegistry,
    events: SubagentEvents = {},
    createSession: typeof createAgentSession = createAgentSession,
  ) {
    this.jobs = jobs;
    this.events = events;
    this.createSession = createSession;
  }

  setEvents(events: SubagentEvents): void {
    this.events = events;
  }

  bindPersistence(
    appendEntry: (customType: string, data: unknown) => void,
    entries: Array<{ customType: string; data?: unknown }>,
    parentSessionId?: string,
  ): void {
    this.persist = appendEntry;
    const restored = [...entries]
      .reverse()
      .find((entry) => entry.customType === SUBAGENTS_ENTRY)?.data as
      | { children?: Array<Partial<ChildSessionRecord> & { sessionId: string }> }
      | undefined;

    for (const item of restored?.children ?? []) {
      if (!item?.sessionId) continue;
      const existing = this.children.get(item.sessionId);
      // Never overwrite an active or already-bound in-memory child session across /reload.
      if (
        existing &&
        (existing.status === 'running' ||
          existing.status === 'queued' ||
          (!existing.needsResume && this.sessions.has(item.sessionId)))
      ) {
        continue;
      }
      const wasActiveWhenSaved = item.status === 'running' || item.status === 'queued';
      const status = wasActiveWhenSaved ? 'cancelled' : (item.status ?? 'completed');
      this.children.set(item.sessionId, {
        sessionId: item.sessionId,
        parentSessionId: item.parentSessionId ?? parentSessionId ?? '',
        description: item.description ?? 'Subagent',
        agent: normalizeSavedAgent(item.agent),
        status,
        startedAt: item.startedAt ?? Date.now(),
        completedAt: item.completedAt ?? Date.now(),
        initialPrompt: item.initialPrompt ?? item.lastPrompt,
        expectedOutput: item.expectedOutput,
        lastPrompt: item.lastPrompt,
        thinking: item.thinking,
        isThinking: false,
        thinkingDurationMs: item.thinkingDurationMs,
        tools: Array.isArray(item.tools) ? item.tools : [],
        result: item.result,
        error: item.error,
        model: item.model,
        interruptedNoticePending: item.interruptedNoticePending ?? (status === 'cancelled'),
        needsResume: true,
        fresh: false,
        run: async () => {
          throw new Error('Child session must be resumed before running');
        },
        abort: async () => {},
      });
    }

    // Backfill from pi-agent-orchestrator.recovery.v1 for sessions recorded before subagents.v1.
    const recoveryData = [...entries]
      .reverse()
      .find((entry) => entry.customType === 'pi-agent-orchestrator.recovery.v1')?.data as
      | { consumed?: JobInfo[] }
      | undefined;
    for (const job of recoveryData?.consumed ?? []) {
      if (job.type !== 'subagent' || this.children.has(job.id)) continue;
      const rec = job.recovery?.kind === 'subagent' ? job.recovery : undefined;
      this.children.set(job.id, {
        sessionId: job.id,
        parentSessionId: rec?.parentSessionId ?? parentSessionId ?? '',
        description: rec?.description ?? job.title ?? 'Subagent',
        agent: normalizeSavedAgent(rec?.agent),
        status: job.status === 'running' || job.status === 'queued' ? 'cancelled' : job.status,
        startedAt: job.startedAt,
        completedAt: job.completedAt ?? Date.now(),
        isThinking: false,
        tools: [],
        result: job.output,
        error: job.error,
        needsResume: true,
        fresh: false,
        run: async () => {
          throw new Error('Child session must be resumed before running');
        },
        abort: async () => {},
      });
    }
  }

  /**
   * Relocates any legacy child `.jsonl` files out of the root session folder
   * and reconstructs child records linked to the active parent session from
   * `subagents/*.jsonl` so `/agents` (`Ctrl+A`) displays full history after
   * `/reload`, `/resume`, or Pi restart.
   */
  async syncParentSession(ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>): Promise<void> {
    const parentFile = ctx.sessionManager.getSessionFile();
    const parentSessionId = ctx.sessionManager.getSessionId();
    if (!parentFile) return;

    relocateLegacyChildSessions(parentFile);
    const childDir = childSessionDirForParent(parentFile);
    if (!existsSync(childDir)) return;

    let sessions: Awaited<ReturnType<typeof SessionManager.list>>;
    try {
      sessions = await SessionManager.list(ctx.cwd, childDir);
    } catch {
      return;
    }

    for (const info of sessions) {
      if (!info?.parentSessionPath || info.parentSessionPath !== parentFile) continue;
      const existing = this.children.get(info.id);
      if (
        existing &&
        (existing.status === 'running' ||
          existing.status === 'queued' ||
          (!existing.needsResume && this.sessions.has(info.id)) ||
          existing.tools.length > 0)
      ) {
        continue;
      }
      try {
        const sm = SessionManager.open(info.path, childDir, ctx.cwd);
        const entries = sm.getEntries();
        const isReviewer = entries.some(
          (entry: any) => entry.type === 'custom' && entry.customType === 'pi-agent-orchestrator.review-task',
        );
        if (isReviewer) continue;

        const metadata = entries.find(
          (entry: any) =>
            entry.type === 'custom' &&
            (entry.customType === CHILD_ENTRY || entry.customType === LEGACY_CHILD_ENTRY),
        ) as { data?: { agent?: string; description?: string; model?: { provider: string; id: string } } } | undefined;
        const saved = metadata?.data;
        const transcript = extractTranscriptState(entries);
        const inferredStatus = existing?.status ?? (transcript.aborted ? 'cancelled' : 'completed');
        this.children.set(info.id, {
          sessionId: info.id,
          parentSessionId,
          description: saved?.description ?? existing?.description ?? info.name ?? 'Subagent',
          agent: normalizeSavedAgent(saved?.agent ?? existing?.agent),
          status: inferredStatus,
          startedAt: existing?.startedAt ?? info.created.getTime(),
          completedAt: existing?.completedAt ?? info.modified.getTime(),
          model: saved?.model?.id ?? existing?.model,
          initialPrompt: existing?.initialPrompt ?? transcript.lastPrompt,
          expectedOutput: existing?.expectedOutput,
          lastPrompt: transcript.lastPrompt ?? existing?.lastPrompt,
          thinking: transcript.thinking ?? existing?.thinking,
          isThinking: false,
          thinkingDurationMs: transcript.thinkingDurationMs ?? existing?.thinkingDurationMs,
          tools: transcript.tools.length > 0 ? transcript.tools : (existing?.tools ?? []),
          result: transcript.result ?? existing?.result,
          error: existing?.error,
          interruptedNoticePending: existing?.interruptedNoticePending ?? (inferredStatus === 'cancelled'),
          needsResume: true,
          fresh: false,
          run: async () => {
            throw new Error('Child session must be resumed before running');
          },
          abort: async () => {},
        });
      } catch {
        // Skip unreadable or corrupted child session files.
      }
    }
  }

  private persistChildren(parentSessionId?: string): void {
    if (!this.persist) return;
    const children = this.list(parentSessionId)
      .slice(0, PERSISTED_SUBAGENT_LIMIT)
      .map((child) => ({
        sessionId: child.sessionId,
        parentSessionId: child.parentSessionId,
        description: child.description,
        agent: child.agent,
        status: child.status,
        startedAt: child.startedAt,
        completedAt: child.completedAt,
        initialPrompt: child.initialPrompt?.slice(0, 4000),
        expectedOutput: child.expectedOutput?.slice(0, 4000),
        lastPrompt: child.lastPrompt?.slice(0, 4000),
        thinking: child.thinking?.slice(0, 4000),
        thinkingDurationMs: child.thinkingDurationMs,
        tools: child.tools.slice(-40).map((t) => ({
          ...t,
          output: t.output ? t.output.slice(0, 1500) : undefined,
        })),
        result: child.result?.slice(0, 8000),
        error: child.error,
        model: child.model,
        interruptedNoticePending: child.interruptedNoticePending,
      }));
    this.persist(SUBAGENTS_ENTRY, { version: 1, children });
  }

  list(parentSessionId?: string): ChildSessionRecord[] {
    return [...this.children.values()]
      .filter((c) => !parentSessionId || !c.parentSessionId || c.parentSessionId === parentSessionId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(sessionId: string): ChildSessionRecord | undefined {
    return this.children.get(sessionId);
  }

  /** Whether the given parent session currently has any running or queued subagent. */
  hasActiveForParent(parentSessionId?: string): boolean {
    for (const child of this.children.values()) {
      if (parentSessionId && child.parentSessionId && child.parentSessionId !== parentSessionId) continue;
      const job = this.jobs.get(child.sessionId);
      if (
        child.status === 'running' ||
        child.status === 'queued' ||
        job?.status === 'running' ||
        job?.status === 'queued'
      ) {
        return true;
      }
    }
    return false;
  }

  /** Aborts every running or queued subagent belonging to the given parent session. */
  async abortAllForParent(parentSessionId?: string): Promise<string[]> {
    const ids: string[] = [];
    for (const child of this.children.values()) {
      if (parentSessionId && child.parentSessionId && child.parentSessionId !== parentSessionId) continue;
      const job = this.jobs.get(child.sessionId);
      if (
        child.status === 'running' ||
        child.status === 'queued' ||
        job?.status === 'running' ||
        job?.status === 'queued'
      ) {
        ids.push(child.sessionId);
      }
    }
    await Promise.all(ids.map((id) => this.abort(id)));
    return ids;
  }

  /**
   * Returns subagents of `parentSessionId` that were stopped before completion
   * (`status === 'cancelled'`) and have a pending resume notice for the parent's
   * next turn, clearing the pending notice flag on each returned record.
   */
  consumeInterruptedForParent(parentSessionId?: string): ChildSessionRecord[] {
    const items: ChildSessionRecord[] = [];
    for (const child of this.children.values()) {
      if (parentSessionId && child.parentSessionId && child.parentSessionId !== parentSessionId) continue;
      if (child.status === 'cancelled' && child.interruptedNoticePending) {
        child.interruptedNoticePending = false;
        items.push(child);
      }
    }
    if (items.length > 0) this.persistChildren(parentSessionId);
    return items.sort((a, b) => b.startedAt - a.startedAt);
  }

  async spawn(
    ctx: ExtensionToolContext,
    input: SpawnSubagentInput,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; status: 'running' | 'completed' | 'cancelled'; output: string; tools: ToolRecord[] }> {
    const parentSessionId = ctx.sessionManager.getSessionId();
    const parentDepth = this.depths.get(parentSessionId) ?? 0;
    if (parentDepth >= DEPTH_LIMIT) throw new Error(`Subagent depth limit reached (${DEPTH_LIMIT}).`);

    let child = input.sessionID ? this.children.get(input.sessionID) : undefined;
    if (input.sessionID && (!child || child.needsResume || !this.sessions.has(input.sessionID))) {
      child = await this.resumeChild(ctx, input.sessionID);
    }
    if (input.sessionID && !child) throw new Error(`Subagent session not found: ${input.sessionID}`);
    if (child && child.parentSessionId !== parentSessionId) {
      throw new Error(`Session ${input.sessionID} is not a child of the current session`);
    }
    if (child && child.agent !== input.agent) {
      throw new Error(`Session ${input.sessionID} is configured for agent ${child.agent}, not ${input.agent}.`);
    }

    if (!child) {
      child = await this.createChild(ctx, input.description, input.agent, input.model, parentDepth + 1);
    } else if (input.model) {
      const selected = this.resolveModel(ctx, input.model);
      const session = this.sessions.get(child.sessionId);
      if (session) await session.setModel(selected);
    }

    child.interruptedNoticePending = false;
    child.initialPrompt ??= input.prompt;
    const effectiveExpectedOutput = input.expectedOutput ?? child.expectedOutput;
    if (input.expectedOutput) child.expectedOutput = input.expectedOutput;

    const existingJob = input.sessionID ? this.jobs.get(child.sessionId) : undefined;
    const isAlreadyActive =
      Boolean(input.sessionID) &&
      (child.status === 'running' ||
        child.status === 'queued' ||
        existingJob?.status === 'running' ||
        existingJob?.status === 'queued');

    if (isAlreadyActive) {
      const steerPrompt = formatSubagentPrompt({
        prompt: input.prompt,
        expectedOutput: effectiveExpectedOutput,
        fresh: false,
      });
      child.lastPrompt = input.prompt.trim();
      const liveSession = this.sessions.get(child.sessionId);
      if (
        existingJob?.status === 'running' &&
        liveSession &&
        typeof (liveSession as { steer?: unknown }).steer === 'function'
      ) {
        await (
          liveSession as {
            steer(text: string, images?: unknown, options?: { source?: string }): Promise<unknown>;
          }
        ).steer(steerPrompt, undefined, { source: 'extension' });
      } else {
        child.pendingSteers ??= [];
        child.pendingSteers.push(steerPrompt);
      }
      this.persistChildren(parentSessionId);
      this.events.changed?.(child);

      if (input.background || existingJob?.status === 'queued') {
        this.jobs.background(child.sessionId);
        return {
          sessionId: child.sessionId,
          status: 'running',
          output: `Steering message injected into running subagent (sessionID: ${child.sessionId}). ${this.backgroundReceipt(child.sessionId)}`,
          tools: [],
        };
      }

      this.jobs.reattach(child.sessionId);
      const runToolStart = child.unreportedToolStart ?? 0;
      const onSteerAbort = () => {
        const current = this.jobs.get(child!.sessionId);
        if (current && !current.notificationId) {
          void this.abort(child!.sessionId);
        }
      };
      if (signal?.aborted) onSteerAbort();
      else signal?.addEventListener('abort', onSteerAbort, { once: true });

      let steeredBlocked: Awaited<ReturnType<JobRegistry['block']>>;
      try {
        steeredBlocked = await this.jobs.block(child.sessionId, parentSessionId);
      } finally {
        signal?.removeEventListener('abort', onSteerAbort);
      }
      if (steeredBlocked?.type === 'backgrounded') {
        return {
          sessionId: child.sessionId,
          status: 'running',
          output: this.backgroundReceipt(child.sessionId),
          tools: [],
        };
      }
      if (steeredBlocked?.info.status === 'error') {
        throw new Error(`Subagent failed (sessionID: ${child.sessionId}): ${steeredBlocked.info.error ?? 'unknown error'}`);
      }
      if (steeredBlocked?.info.status === 'cancelled') {
        const partial = child.result?.trim();
        const resumeNote = `Subagent was stopped before completion. Its conversation and completed tool calls are preserved in sessionID="${child.sessionId}". When continuing, resume this subagent by calling subagent with agent="${input.agent}" and sessionID="${child.sessionId}" rather than redoing its work from scratch.`;
        return {
          sessionId: child.sessionId,
          status: 'cancelled',
          output: partial ? `${truncateSubagentOutput(partial)}\n\n[${resumeNote}]` : resumeNote,
          tools: child.tools.slice(runToolStart),
        };
      }
      child.unreportedToolStart = child.tools.length;
      return {
        sessionId: child.sessionId,
        status: 'completed',
        output: truncateSubagentOutput(steeredBlocked?.info.output ?? SUBAGENT_NO_TEXT),
        tools: child.tools.slice(runToolStart),
      };
    }

    const controller = new AbortController();
    this.running.set(child.sessionId, controller);
    const reviewRequested = input.review === true && isCodingAgent(input.agent);
    const reviewParentPath = reviewRequested
      ? ctx.sessionManager.getSessionFile()
      : undefined;
    child.status = 'queued';
    child.error = undefined;

    const combinedPrompt =
      child.fresh &&
      Boolean(input.sessionID) &&
      child.initialPrompt &&
      input.prompt.trim() !== child.initialPrompt.trim()
        ? `${child.initialPrompt.trim()}\n\n${input.prompt.trim()}`
        : input.prompt;

    const prompt = formatSubagentPrompt({
      prompt: combinedPrompt,
      expectedOutput: effectiveExpectedOutput,
      fresh: child.fresh,
    });
    let queuedAtLaunch = false;
    const runToolStart = child.unreportedToolStart ?? 0;

    const job = this.jobs.start({
      id: child.sessionId,
      type: 'subagent',
      title: child.description,
      started: (info) => {
        child!.startedAt = info.startedAt;
        child!.status = 'running';
        this.persistChildren(parentSessionId);
        this.events.changed?.(child!);
        this.events.started?.(child!, info);
      },
      recovery: {
        kind: 'subagent',
        parentSessionId,
        childSessionId: child.sessionId,
        agent: input.agent,
        description: child.description,
      },
      run: async () => {
        const implementationToolStart = child!.tools.length;
        const implementationToolCalls = new Set(child!.tools.map((tool) => tool.toolCallId).filter(Boolean));
        const implementation = await child!.run(prompt, controller.signal);
        if (!reviewRequested || controller.signal.aborted) return implementation;
        const gate = await runReviewGate({
          task: combinedPrompt,
          implementationTools: child!.tools.slice(implementationToolStart)
            .filter((tool) => !tool.toolCallId || !implementationToolCalls.has(tool.toolCallId)),

          runReview: (reviewPrompt, attempt, priorFindings) =>
            this.runReviewer(ctx, child!, input.model, reviewParentPath, reviewPrompt, attempt, priorFindings, controller.signal),
          runFix: async (fixPrompt) => {
            const revisionStart = child!.tools.length;
            const report = await child!.run(fixPrompt, controller.signal);
            return { report, tools: child!.tools.slice(revisionStart) };
          },
        });
        if (controller.signal.aborted) return implementation;
        if (gate.verdict !== 'PASS') {
          throw new Error(`Implementation was not verified (sessionID: ${child!.sessionId}). Review verdict: ${gate.verdict}. ${gate.review}`);
        }
        return gate.fixRounds === 0
          ? `Implementation verified against the task by an independent reviewer.\n\n${implementation}\n\nReview:\n${gate.review}`
          : `Implementation verified after one bounded fix/review round.\n\n${gate.review}`;
      },
      cancel: () => child!.abort(),
      settled: (info) => this.onSettled(child!, info),
    });

    queuedAtLaunch = job.status === 'queued';
    if (queuedAtLaunch || input.background) {
      this.jobs.background(job.id);
      const prefix = queuedAtLaunch && !input.background
        ? 'The subagent is queued and will start when a worker is available.'
        : '';
      return {
        sessionId: child.sessionId,
        status: 'running',
        output: `${prefix} ${this.backgroundReceipt(child.sessionId)}`.trim(),
        tools: [],
      };
    }

    const onAbort = () => {
      const current = this.jobs.get(job.id);
      if (current && !current.notificationId) {
        void this.abort(job.id);
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    let blocked: Awaited<ReturnType<JobRegistry['block']>>;
    try {
      blocked = await this.jobs.block(job.id, parentSessionId);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (blocked?.type === 'backgrounded') {
      const prefix = queuedAtLaunch ? 'The subagent is queued and will start when a worker is available.' : '';
      return {
        sessionId: child.sessionId,
        status: 'running',
        output: `${prefix} ${this.backgroundReceipt(child.sessionId)}`.trim(),
        tools: [],
      };
    }
    if (blocked?.info.status === 'error') {
      throw new Error(`Subagent failed (sessionID: ${child.sessionId}): ${blocked.info.error ?? 'unknown error'}`);
    }
    if (blocked?.info.status === 'cancelled') {
      const partial = child.result?.trim();
      const resumeNote = `Subagent was stopped before completion. Its conversation and completed tool calls are preserved in sessionID="${child.sessionId}". When continuing, resume this subagent by calling subagent with agent="${input.agent}" and sessionID="${child.sessionId}" rather than redoing its work from scratch.`;
      return {
        sessionId: child.sessionId,
        status: 'cancelled',
        output: partial ? `${truncateSubagentOutput(partial)}\n\n[${resumeNote}]` : resumeNote,
        tools: child.tools.slice(runToolStart),
      };
    }
    child.unreportedToolStart = child.tools.length;
    return {
      sessionId: child.sessionId,
      status: 'completed',
      output: truncateSubagentOutput(blocked?.info.output ?? SUBAGENT_NO_TEXT),
      tools: child.tools.slice(runToolStart),
    };
  }

  /** Run one independent reviewer in a fresh read-only session. */
  private async runReviewer(
    ctx: ExtensionToolContext,
    implementer: ChildSessionRecord,
    modelRef: string | undefined,
    reviewParentPath: string | undefined,
    prompt: string,
    attempt: number,
    priorFindings?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) return '';
    const reviewer = await this.createChild(
      ctx,
      `Review ${implementer.description} ${attempt}`,
      'review',
      modelRef,
      1,
      priorFindings ?? prompt,
      reviewParentPath,
      true,
    );
    const onAbort = () => {
      void reviewer.abort();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await reviewer.run(prompt, signal);
      implementer.tools.push(...reviewer.tools);
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.children.delete(reviewer.sessionId);
      const session = this.sessions.get(reviewer.sessionId);
      session?.dispose();
      this.sessions.delete(reviewer.sessionId);
    }
  }

  private backgroundReceipt(sessionId: string): string {
    const child = this.children.get(sessionId);
    const agentPart = child?.agent ? `, agent: "${child.agent}"` : '';
    const descPart = child?.description ? `, description: ${JSON.stringify(child.description)}` : '';
    return `The subagent is working in the background (sessionID: ${sessionId}). You will be notified automatically when it finishes.\nYou can steer this running subagent at any time by calling subagent({ sessionID: "${sessionId}"${agentPart}${descPart}, prompt: "<new instructions>" }), or stop it with job_cancel({ id: "${sessionId}" }).\nDo not sleep, poll, ask the subagent for status, or duplicate its work. Work on a non-overlapping task, or respond to the user now.`;
  }

  private onSettled(child: ChildSessionRecord, info: JobInfo): void {
    this.running.delete(child.sessionId);
    if (info.status === 'error') {
      child.status = 'error';
      child.error = info.error;
      child.completedAt = info.completedAt;
    } else if (info.status === 'cancelled') {
      child.status = 'cancelled';
      child.completedAt = info.completedAt;
      child.interruptedNoticePending = true;
    } else if (child.status !== 'completed') {
      child.status = 'completed';
      child.completedAt = info.completedAt;
      child.result = info.output;
      child.interruptedNoticePending = false;
    }
    this.persistChildren(child.parentSessionId);
    this.events.changed?.(child);
    this.events.completed?.(child, info);
  }

  private resolveModel(ctx: ExtensionToolContext, modelRef: string) {
    const [provider, ...rest] = modelRef.split('/');
    const selected = ctx.modelRegistry.find(provider!, rest.join('/'));
    if (!selected) throw new Error(`Model is unavailable: ${modelRef}`);
    return selected;
  }

  /** Reopens a child session from disk (or rebinds an in-memory session) so its conversation can continue. */
  private async resumeChild(ctx: ExtensionToolContext, sessionId: string): Promise<ChildSessionRecord | undefined> {
    const existing = this.children.get(sessionId);
    const liveSession = this.sessions.get(sessionId);
    if (existing && liveSession) {
      if (existing.needsResume) {
        const { activeTools } = resolveChildTools(ctx, existing.agent);
        existing.run = (prompt, runSignal) => this.runChild(liveSession, activeTools, existing, prompt, runSignal);
        existing.abort = async () => {
          this.running.get(sessionId)?.abort();
          await liveSession.abort();
          existing.status = 'cancelled';
          existing.completedAt = Date.now();
          this.events.changed?.(existing);
        };
        existing.needsResume = false;
      }
      return existing;
    }

    const cwd = ctx.cwd;
    const parentFile = ctx.sessionManager.getSessionFile();
    if (!parentFile) return undefined;
    relocateLegacyChildSessions(parentFile);
    const childDir = childSessionDirForParent(parentFile);
    const sessions = await SessionManager.list(cwd, childDir);
    let info = sessions.find((entry) => entry.id === sessionId);
    if (!info) {
      const legacy = await SessionManager.list(cwd);
      info = legacy.find((entry) => entry.id === sessionId);
    }
    const normPath = (p?: string) => p?.replace(/\\/g, '/').toLowerCase();
    if (!info?.parentSessionPath || normPath(info.parentSessionPath) !== normPath(parentFile)) return undefined;

    const sessionManager = SessionManager.open(info.path, childDir, cwd);
    const entries = sessionManager.getEntries();
    const metadata = entries.find(
      (entry) =>
        entry.type === 'custom' &&
        (entry.customType === CHILD_ENTRY || entry.customType === LEGACY_CHILD_ENTRY),
    ) as { data?: { agent?: AgentKind; description?: string; model?: { provider: string; id: string } } } | undefined;
    const saved = metadata?.data;
    const agent = normalizeSavedAgent(saved?.agent ?? existing?.agent);
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
    const model = saved?.model ? ctx.modelRegistry.find(saved.model.provider, saved.model.id) : ctx.model;
    const systemPrompt = agentSystemPrompt(agent);
    const { activeTools, excludeTools, customTools } = resolveChildTools(ctx, agent);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      // A child must not load extensions: the orchestrator itself is already
      // running in the parent, and loading it again would duplicate tools.
      noExtensions: true,
      extensionFactories: [
        { name: 'orchestrator-codemode', factory: createCodemodeExtension() },
        ...(isReadOnlyAgent(agent)
          ? [{ name: 'orchestrator-read-only', factory: createReadOnlyGuard({ cwd }) }]
          : []),
      ],
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    await resourceLoader.reload();

    const childSession = await this.createSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: ctx.thinkingLevel ?? 'medium',
      sessionManager,
      settingsManager,
      resourceLoader,
      tools: activeTools,
      excludeTools,
      ...(customTools.length > 0 ? { customTools } : {}),
    });
    const session = childSession.session;
    const transcript = extractTranscriptState(entries);
    const hasPriorUserMessages = Array.isArray(session.messages)
      ? session.messages.some((m: any) => m?.role === 'user')
      : Boolean(transcript.lastPrompt);

    const child: ChildSessionRecord = {
      sessionId: session.sessionId,
      parentSessionId: ctx.sessionManager.getSessionId(),
      description: saved?.description ?? existing?.description ?? info.name ?? 'Subagent',
      agent,
      status: existing?.status ?? (transcript.aborted ? 'cancelled' : 'completed'),
      startedAt: existing?.startedAt ?? info.created.getTime(),
      completedAt: existing?.completedAt ?? info.modified.getTime(),
      model: model?.id,
      initialPrompt: existing?.initialPrompt ?? transcript.lastPrompt,
      expectedOutput: existing?.expectedOutput,
      lastPrompt: existing?.lastPrompt ?? transcript.lastPrompt,
      thinking: existing?.thinking ?? transcript.thinking,
      isThinking: false,
      thinkingDurationMs: existing?.thinkingDurationMs ?? transcript.thinkingDurationMs,
      tools: existing?.tools.length ? existing.tools : transcript.tools,
      result: existing?.result ?? transcript.result,
      interruptedNoticePending: existing?.interruptedNoticePending,
      unreportedToolStart: existing?.unreportedToolStart,
      needsResume: false,
      fresh: !hasPriorUserMessages,
      run: (prompt, runSignal) => this.runChild(session, activeTools, child, prompt, runSignal),
      abort: async () => {
        this.running.get(session.sessionId)?.abort();
        await session.abort();
        child.status = 'cancelled';
        child.completedAt = Date.now();
        this.events.changed?.(child);
      },
    };
    this.sessions.set(sessionId, session);
    this.depths.set(sessionId, 1);
    this.children.set(sessionId, child);
    this.events.changed?.(child);
    return child;
  }

  private async createChild(
    ctx: ExtensionToolContext,
    description: string,
    agent: AgentKind,
    modelRef: string | undefined,
    depth: number,
    initialPrompt?: string,
    parentSessionFileOverride?: string,
    reviewerMode = false,
  ): Promise<ChildSessionRecord> {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
    let model = ctx.model;
    if (modelRef) model = this.resolveModel(ctx, modelRef);
    const systemPrompt = agentSystemPrompt(agent, reviewerMode);
    const { activeTools, excludeTools, customTools } = resolveChildTools(ctx, agent, reviewerMode);

    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [
        { name: 'orchestrator-codemode', factory: createCodemodeExtension() },
        ...(isReadOnlyAgent(agent)
          ? [{ name: 'orchestrator-read-only', factory: createReadOnlyGuard({ cwd: ctx.cwd }) }]
          : []),
      ],
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    await resourceLoader.reload();

    const parentSessionFile = parentSessionFileOverride ?? ctx.sessionManager.getSessionFile();
    const sessionManager = parentSessionFile
      ? SessionManager.create(ctx.cwd, childSessionDirForParent(parentSessionFile), { parentSession: parentSessionFile })
      : SessionManager.inMemory(ctx.cwd);
    if (parentSessionFile) {
      sessionManager.appendCustomEntry(CHILD_ENTRY, {
        agent,
        description,
        model: model ? { provider: model.provider, id: model.id } : undefined,
      });
    }

    const childSession = await this.createSession({
      cwd: ctx.cwd,
      agentDir,
      model,
      thinkingLevel: ctx.thinkingLevel ?? 'medium',
      sessionManager,
      settingsManager,
      resourceLoader,
      tools: activeTools,
      excludeTools,
      ...(customTools.length > 0 ? { customTools } : {}),
    });
    const session = childSession.session;
    if (initialPrompt) session.sessionManager.appendCustomEntry('pi-agent-orchestrator.review-task', { prompt: initialPrompt });
    if (model && (session.model?.provider !== model.provider || session.model?.id !== model.id)) {
      await session.setModel(model);
    }

    const child: ChildSessionRecord = {
      sessionId: session.sessionId,
      parentSessionId: ctx.sessionManager.getSessionId(),
      description,
      agent,
      status: 'running',
      startedAt: Date.now(),
      model: model?.id,
      tools: [],
      fresh: true,
      run: (prompt, runSignal) => this.runChild(session, activeTools, child, prompt, runSignal),
      abort: async () => {
        this.running.get(session.sessionId)?.abort();
        await session.abort();
        child.status = 'cancelled';
        child.completedAt = Date.now();
        this.events.changed?.(child);
      },
    };
    this.sessions.set(session.sessionId, session);
    this.depths.set(session.sessionId, depth);
    this.children.set(session.sessionId, child);
    this.events.changed?.(child);
    return child;
  }

  /**
   * Prompts a child session and collects its tool activity and final text.
   *
   * The tool list and the final text are read from the session itself, so this
   * works the same for a fresh child and a resumed one.
   */
  private async runChild(
    session: Awaited<ReturnType<typeof createAgentSession>>['session'],
    activeTools: readonly string[],
    child: ChildSessionRecord,
    prompt: string,
    runSignal?: AbortSignal,
  ): Promise<string> {
    child.fresh = false;
    child.lastPrompt = prompt.replace(new RegExp(`^${FRESH_PROMPT}\\r?\\n+`), '');
    child.thinking = '';
    child.isThinking = false;
    child.thinkingStartedAt = undefined;
    child.thinkingDurationMs = 0;
    session.setActiveToolsByName([...activeTools]);
    const initialMsgCount = Array.isArray(session.messages) ? session.messages.length : 0;
    const runToolStart = child.tools.length;
    let deltaThinking = '';

    const startThinking = () => {
      if (!child.isThinking) {
        child.isThinking = true;
        child.thinkingStartedAt = Date.now();
      }
    };

    const stopThinking = () => {
      if (child.isThinking) {
        const now = Date.now();
        child.thinkingDurationMs = (child.thinkingDurationMs ?? 0) + Math.max(0, now - (child.thinkingStartedAt ?? now));
        child.isThinking = false;
        child.thinkingStartedAt = undefined;
      }
    };

    const extractMessageThinking = (msg: any): string[] => {
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return [];
      return msg.content
        .filter((part: any) => part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim())
        .map((part: any) => part.thinking.trim());
    };

    const syncThinkingFromSession = (activeMessage?: any) => {
      const blocks: string[] = [];
      const history = Array.isArray(session.messages) ? session.messages.slice(initialMsgCount) : [];
      for (const msg of history) {
        if (msg === activeMessage) continue;
        blocks.push(...extractMessageThinking(msg));
      }
      if (activeMessage) {
        blocks.push(...extractMessageThinking(activeMessage));
      }
      const fromBlocks = blocks.join('\n\n').trim();
      if (fromBlocks.length >= deltaThinking.trim().length && fromBlocks.length > 0) {
        child.thinking = fromBlocks;
      } else if (deltaThinking) {
        child.thinking = deltaThinking;
      }
    };

    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update') {
        const ame = (event as any).assistantMessageEvent;
        const wasThinking = child.isThinking;
        if (ame?.type === 'thinking_start') {
          startThinking();
        } else if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          startThinking();
          deltaThinking += ame.delta;
        } else if (ame?.type === 'thinking_end') {
          if (typeof ame.content === 'string' && ame.content.length > deltaThinking.length) {
            deltaThinking = ame.content;
          }
          stopThinking();
        } else if (
          ame?.type === 'text_start' ||
          ame?.type === 'text_delta' ||
          ame?.type === 'toolcall_start' ||
          ame?.type === 'toolcall_delta' ||
          ame?.type === 'toolcall_end' ||
          ame?.type === 'done' ||
          ame?.type === 'error'
        ) {
          stopThinking();
        }
        // Skip expensive transcript scans on toolcall_delta once thinking has already stopped.
        if (ame?.type === 'toolcall_delta' && !wasThinking) {
          return;
        }
        syncThinkingFromSession((event as any).message);
        const msg = (event as any).message;
        if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
          const liveText = msg.content
            .filter((part: any) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim())
            .map((part: any) => part.text.trim())
            .join('\n\n');
          if (liveText) child.result = liveText;
        }
        this.events.changed?.(child);
      } else if (event.type === 'message_end') {
        stopThinking();
        syncThinkingFromSession((event as any).message);
        this.events.changed?.(child);
      } else if (event.type === 'tool_execution_start') {
        stopThinking();
        const record: ToolRecord = {
          toolCallId: event.toolCallId,
          parentToolCallId: (event as { parentToolCallId?: string }).parentToolCallId,
          name: event.toolName,
          input: event.args,
          startedAt: Date.now(),
          status: 'running',
        };
        child.tools.push(record);
        this.events.changed?.(child);
      } else if (event.type === 'tool_execution_update') {
        const record = child.tools.findLast((item) => item.toolCallId === event.toolCallId && item.status === 'running');
        if (record) {
          const partial = (event as any).partialResult;
          if (partial?.details !== undefined) record.details = partial.details;
          const text = partial?.content
            ?.filter((part: any) => part.type === 'text')
            .map((part: any) => part.text)
            .join('\n');
          if (text) record.output = text;
        }
        this.events.changed?.(child);
      } else if (event.type === 'tool_execution_end') {
        const record = child.tools.findLast((item) => item.toolCallId === event.toolCallId && item.status === 'running');
        if (record) {
          record.completedAt = Date.now();
          record.durationMs =
            typeof (event as { durationMs?: unknown }).durationMs === 'number'
              ? (event as { durationMs: number }).durationMs
              : Math.max(0, record.completedAt - record.startedAt);
          record.status = event.isError ? 'error' : 'completed';
          record.details = event.result?.details ?? record.details;
          record.exitCode = event.result?.structuredContent?.exit_code ?? event.result?.structuredContent?.exitCode;
          const structuredOutput = event.result?.structuredContent?.output;
          const text = event.result?.content
            ?.filter((part: any) => part.type === 'text')
            .map((part: any) => part.text)
            .join('\n');
          if (typeof structuredOutput === 'string') record.output = structuredOutput;
          else if (text) record.output = text;
        }
        this.events.changed?.(child);
      }
    });

    const extractAssistantText = () => {
      const history = Array.isArray(session.messages)
        ? session.messages.slice(initialMsgCount)
        : [];
      const last = [...history]
        .reverse()
        .find((message) => message.role === 'assistant');
      const fromContent = last?.content
        ?.filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .filter(Boolean)
        .join('\n\n')
        ?.trim();
      if (fromContent) return fromContent;
      if (history.length === 0) return session.getLastAssistantText()?.trim() || '';
      return '';
    };

    const wasTurnAborted = () => {
      if (runSignal?.aborted) return true;
      const history = Array.isArray(session.messages) ? session.messages.slice(initialMsgCount) : [];
      const last = [...history].reverse().find((message: any) => message?.role === 'assistant') as
        | { stopReason?: string; errorMessage?: string }
        | undefined;
      return (
        last?.stopReason === 'aborted' ||
        last?.stopReason === 'error' ||
        Boolean(last?.errorMessage)
      );
    };

    try {
      if (runSignal?.aborted) return SUBAGENT_NO_TEXT;
      await session.prompt(prompt);
      while (child.pendingSteers && child.pendingSteers.length > 0 && !wasTurnAborted()) {
        const nextSteer = child.pendingSteers.shift()!;
        child.lastPrompt = nextSteer.replace(new RegExp(`^${FRESH_PROMPT}\\r?\\n+`), '');
        await session.prompt(nextSteer);
      }
      syncThinkingFromSession();
      let text = extractAssistantText();
      // One-shot pre-settlement nudge (MAST FM-3.1): if the child executed tools
      // during this turn but stopped without producing any final text summary,
      // prompt once so it synthesizes its findings before returning to the parent.
      // Never send this nudge if the turn was aborted (e.g. user pressed Esc).
      if (!text && child.tools.length > runToolStart && !wasTurnAborted()) {
        await session.prompt(EMPTY_COMPLETION_NUDGE);
        syncThinkingFromSession();
        text = extractAssistantText();
      }
      if (text) child.result = text;
      return text || SUBAGENT_NO_TEXT;
    } catch (error) {
      if (!runSignal?.aborted) {
        child.status = 'error';
        child.error = error instanceof Error ? error.message : String(error);
        child.completedAt = Date.now();
        this.events.changed?.(child);
      }
      throw error;
    } finally {
      const now = Date.now();
      for (let i = runToolStart; i < child.tools.length; i++) {
        const item = child.tools[i];
        if (item && item.status === 'running') {
          item.completedAt = now;
          item.durationMs = Math.max(0, now - item.startedAt);
          item.status = runSignal?.aborted ? 'error' : 'completed';
        }
      }
      stopThinking();
      unsubscribe();
    }
  }

  async abort(sessionId: string): Promise<void> {
    if (!this.children.has(sessionId)) return;
    this.running.get(sessionId)?.abort();
    // JobRegistry owns cancellation ordering: it marks the request, aborts the
    // session through the registered cancel callback, and only settles after
    // the prompt operation actually stops.
    await this.jobs.cancel(sessionId);
  }

  /** Used by the tests to keep ids stable. */
  static newId(): string {
    return randomUUID();
  }
}
