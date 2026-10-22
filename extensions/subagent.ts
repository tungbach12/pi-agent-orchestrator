import { randomUUID } from 'node:crypto';
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';
import { JobRegistry } from './jobs.js';
import { EXPLORE_PROMPT, FRESH_PROMPT, SUBAGENT_NO_TEXT } from './prompts.js';
import { createReadOnlyGuard } from './read-only.js';
import { AGENT_TOOLS, type AgentKind, type ChildRecord, type JobInfo, type ToolRecord } from './types.js';

/** Custom session entry that records which agent a child session belongs to. */
const CHILD_ENTRY = 'pi-agent-orchestrator.child';

/** How deep a child session may nest another child session. */
const DEPTH_LIMIT = 1;

export interface ChildSessionRecord extends ChildRecord {
  parentSessionId: string;
  lastPrompt?: string;
  thinking?: string;
  /** True until the child has been prompted for the first time. */
  fresh: boolean;
  run: (prompt: string) => Promise<string>;
  abort: () => Promise<void>;
}

export interface SubagentEvents {
  changed?: (record: ChildSessionRecord) => void;
  /** Fired once the child reached a terminal state. */
  completed?: (record: ChildSessionRecord, info: JobInfo) => void;
}

export type SpawnSubagentInput = {
  agent: AgentKind;
  description: string;
  prompt: string;
  model?: string;
  sessionID?: string;
  background?: boolean;
};

/**
 * Runs child agent sessions.
 *
 * A child is a real Pi session with its own file, so it can be resumed later by
 * passing its session id. The child gets its own tool set: `explore` is limited
 * to Pi's read-only search tools, `general` gets the coding tools.
 */
export class SubagentManager {
  private readonly children = new Map<string, ChildSessionRecord>();
  private readonly sessions = new Map<string, Awaited<ReturnType<typeof createAgentSession>>['session']>();
  private readonly running = new Map<string, AbortController>();
  private readonly depths = new Map<string, number>();

  constructor(
    private readonly jobs: JobRegistry,
    private readonly events: SubagentEvents = {},
  ) {}

  list(): ChildSessionRecord[] {
    return [...this.children.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(sessionId: string): ChildSessionRecord | undefined {
    return this.children.get(sessionId);
  }

  async spawn(
    ctx: ExtensionToolContext,
    input: SpawnSubagentInput,
  ): Promise<{ sessionId: string; status: 'running' | 'completed'; output: string }> {
    const parentSessionId = ctx.sessionManager.getSessionId();
    const parentDepth = this.depths.get(parentSessionId) ?? 0;
    if (parentDepth >= DEPTH_LIMIT) throw new Error(`Subagent depth limit reached (${DEPTH_LIMIT}).`);

    let child = input.sessionID ? this.children.get(input.sessionID) : undefined;
    if (input.sessionID && !child) child = await this.resumeChild(ctx, input.sessionID);
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

    const controller = this.running.get(child.sessionId) ?? new AbortController();
    this.running.set(child.sessionId, controller);
    child.status = 'running';
    child.error = undefined;

    const prompt = child.fresh ? `${FRESH_PROMPT}\n${input.prompt}` : input.prompt;
    child.fresh = false;

    const job = this.jobs.start({
      id: child.sessionId,
      type: 'subagent',
      title: child.description,
      recovery: {
        kind: 'subagent',
        parentSessionId,
        childSessionId: child.sessionId,
        agent: input.agent,
        description: child.description,
      },
      run: async () => child!.run(prompt),
      settled: (info) => this.onSettled(child!, info),
    });

    if (input.background) {
      this.jobs.background(job.id);
      return {
        sessionId: child.sessionId,
        status: 'running',
        output: this.backgroundReceipt(child.sessionId),
      };
    }

    const blocked = await this.jobs.block(job.id, parentSessionId);
    if (blocked?.type === 'backgrounded') {
      return { sessionId: child.sessionId, status: 'running', output: this.backgroundReceipt(child.sessionId) };
    }
    if (blocked?.info.status === 'error') {
      throw new Error(`Subagent failed (sessionID: ${child.sessionId}): ${blocked.info.error ?? 'unknown error'}`);
    }
    if (blocked?.info.status === 'cancelled') {
      throw new Error(`Subagent cancelled (sessionID: ${child.sessionId})`);
    }
    return { sessionId: child.sessionId, status: 'completed', output: blocked?.info.output ?? SUBAGENT_NO_TEXT };
  }

  private backgroundReceipt(sessionId: string): string {
    return `The subagent is working in the background (sessionID: ${sessionId}). You will be notified automatically when it finishes.\nDo not sleep, poll, ask the subagent for status, or duplicate its work. Work on a non-overlapping task, or briefly tell the user what you launched and end your response.`;
  }

  private onSettled(child: ChildSessionRecord, info: JobInfo): void {
    if (info.status === 'error') {
      child.status = 'error';
      child.error = info.error;
      child.completedAt = info.completedAt;
    } else if (info.status === 'cancelled') {
      child.status = 'cancelled';
      child.completedAt = info.completedAt;
    } else if (child.status !== 'completed') {
      child.status = 'completed';
      child.completedAt = info.completedAt;
      child.result = info.output;
    }
    this.events.changed?.(child);
    this.events.completed?.(child, info);
  }

  private resolveModel(ctx: ExtensionToolContext, modelRef: string) {
    const [provider, ...rest] = modelRef.split('/');
    const selected = ctx.modelRegistry.find(provider!, rest.join('/'));
    if (!selected) throw new Error(`Model is unavailable: ${modelRef}`);
    return selected;
  }

  /** Reopens a child session from disk so its conversation can continue. */
  private async resumeChild(ctx: ExtensionToolContext, sessionId: string): Promise<ChildSessionRecord | undefined> {
    if (this.children.has(sessionId)) return this.children.get(sessionId);
    if (this.depths.get(sessionId) !== undefined) return undefined;

    const cwd = ctx.cwd;
    const parentFile = ctx.sessionManager.getSessionFile();
    if (!parentFile) return undefined;
    const sessions = await SessionManager.list(cwd);
    const info = sessions.find((entry) => entry.id === sessionId);
    if (!info?.parentSessionPath || info.parentSessionPath !== parentFile) return undefined;

    const sessionManager = SessionManager.open(info.path, undefined, cwd);
    const metadata = sessionManager.getEntries().find(
      (entry) => entry.type === 'custom' && entry.customType === CHILD_ENTRY,
    ) as { data?: { agent?: AgentKind; description?: string; model?: { provider: string; id: string } } } | undefined;
    const saved = metadata?.data;
    if (!saved?.agent) return undefined;

    const agent = saved.agent;
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
    const model = saved?.model ? ctx.modelRegistry.find(saved.model.provider, saved.model.id) : ctx.model;
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      // A child must not load extensions: the orchestrator itself is already
      // running in the parent, and loading it again would duplicate tools.
      noExtensions: true,
      // The explore agent gets a shell for read-only commands. The guard below
      // blocks the calls that would change anything.
      ...(agent === 'explore'
        ? { extensionFactories: [{ name: 'orchestrator-read-only', factory: createReadOnlyGuard() }] }
        : {}),
      ...(agent === 'explore' ? { systemPrompt: EXPLORE_PROMPT } : {}),
    });
    await resourceLoader.reload();

    const childSession = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: ctx.thinkingLevel ?? 'medium',
      sessionManager,
      settingsManager,
      resourceLoader,
      tools: [...AGENT_TOOLS[agent]],
    });
    const session = childSession.session;

    const child: ChildSessionRecord = {
      sessionId: session.sessionId,
      parentSessionId: ctx.sessionManager.getSessionId(),
      description: saved.description ?? info.name ?? 'Subagent',
      agent,
      status: 'completed',
      startedAt: info.created.getTime(),
      completedAt: info.modified.getTime(),
      model: model?.id,
      tools: [],
      fresh: false,
      run: (prompt) => this.runChild(session, agent, child, prompt),
      abort: async () => {
        await session.abort();
        child.status = 'cancelled';
        child.completedAt = Date.now();
        this.events.changed?.(child);
      },
    };
    this.sessions.set(sessionId, session);
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
  ): Promise<ChildSessionRecord> {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
    let model = ctx.model;
    if (modelRef) model = this.resolveModel(ctx, modelRef);

    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      ...(agent === 'explore'
        ? { extensionFactories: [{ name: 'orchestrator-read-only', factory: createReadOnlyGuard() }] }
        : {}),
      ...(agent === 'explore' ? { systemPrompt: EXPLORE_PROMPT } : {}),
    });
    await resourceLoader.reload();

    const parentSessionFile = ctx.sessionManager.getSessionFile();
    const sessionManager = parentSessionFile
      ? SessionManager.create(ctx.cwd, undefined, { parentSession: parentSessionFile })
      : SessionManager.inMemory(ctx.cwd);
    if (parentSessionFile) {
      sessionManager.appendCustomEntry(CHILD_ENTRY, {
        agent,
        description,
        model: model ? { provider: model.provider, id: model.id } : undefined,
      });
    }

    const childSession = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      model,
      thinkingLevel: ctx.thinkingLevel ?? 'medium',
      sessionManager,
      settingsManager,
      resourceLoader,
      tools: [...AGENT_TOOLS[agent]],
    });
    const session = childSession.session;
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
      run: (prompt) => this.runChild(session, agent, child, prompt),
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
    agent: AgentKind,
    child: ChildSessionRecord,
    prompt: string,
  ): Promise<string> {
    child.lastPrompt = prompt;
    child.thinking = '';
    session.setActiveToolsByName([...AGENT_TOOLS[agent]]);

    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'thinking_delta') {
        child.thinking = (child.thinking ?? '') + event.assistantMessageEvent.delta;
        this.events.changed?.(child);
      } else if (event.type === 'tool_execution_start') {
        const record: ToolRecord = {
          name: event.toolName,
          input: event.args,
          startedAt: Date.now(),
          status: 'running',
        };
        child.tools.push(record);
        this.events.changed?.(child);
      } else if (event.type === 'tool_execution_end') {
        const record = child.tools.findLast((item) => item.name === event.toolName && item.status === 'running');
        if (record) {
          record.completedAt = Date.now();
          record.status = event.isError ? 'error' : 'completed';
          const text = event.result?.content
            ?.filter((part: any) => part.type === 'text')
            .map((part: any) => part.text)
            .join('\n');
          if (text) record.output = text;
        }
        this.events.changed?.(child);
      }
    });

    try {
      await session.prompt(prompt);
      const last = [...session.messages]
        .reverse()
        .find((message) => message.role === 'assistant');
      const text = last?.content
        ?.filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .filter(Boolean)
        .join('\n\n');
      return text || session.getLastAssistantText() || SUBAGENT_NO_TEXT;
    } catch (error) {
      child.status = 'error';
      child.error = error instanceof Error ? error.message : String(error);
      child.completedAt = Date.now();
      this.events.changed?.(child);
      throw error;
    } finally {
      unsubscribe();
    }
  }

  async abort(sessionId: string): Promise<void> {
    const child = this.children.get(sessionId);
    if (!child) return;
    await child.abort();
    await this.jobs.cancel(sessionId);
  }

  /** Used by the tests to keep ids stable. */
  static newId(): string {
    return randomUUID();
  }
}
