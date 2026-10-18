import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createAgentSession, createLocalBashOperations, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { JobRegistry } from './jobs.js';
import { BACKGROUND_INSTRUCTION, shellNotice } from './shell-result.js';
import { EXPLORE_PROMPT, FRESH_PROMPT, SUBAGENT_NO_TEXT } from './prompts.js';
import type { JobInfo, ShellOutput, ShellRecord, ToolRecord, SubagentInput } from './types.js';

export { BACKGROUND_INSTRUCTION, shellNotice } from './shell-result.js';
export { EXPLORE_PROMPT, GENERAL_PROMPT } from './prompts.js';

export const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 50 * 1024 * 1024;
const MEMORY_TAIL_BYTES = 64 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_READ_BYTES = 16 * 1024;

export interface ShellEvents {
  changed?: (record: ShellRecord) => void;
  completed?: (info: JobInfo, record: ShellRecord) => void;
}

export class ShellManager {
  readonly jobs: JobRegistry;
  private readonly records = new Map<string, ShellRecord>();
  private readonly running = new Map<string, AbortController>();

  constructor(jobs: JobRegistry, private readonly events: ShellEvents = {}) {
    this.jobs = jobs;
  }

  list(): ShellRecord[] {
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(shellId: string): ShellRecord | undefined {
    return this.records.get(shellId);
  }

  async output(shellId: string, offset = 0, limit = DEFAULT_READ_BYTES): Promise<ShellOutput> {
    const record = this.records.get(shellId);
    if (!record) throw new Error(`Unknown shell ID: ${shellId}`);
    const file = await open(record.file, 'r').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!file) return { shellID: shellId, status: record.status, output: '', truncated: false };
    try {
      const size = (await file.stat()).size;
      const start = Math.max(0, Math.min(size, Math.floor(offset)));
      const length = Math.max(1, Math.min(MAX_READ_BYTES, Math.floor(limit)));
      const buffer = Buffer.alloc(Math.min(length, Math.max(0, size - start)));
      if (buffer.length) await file.read(buffer, 0, buffer.length, start);
      const output = buffer.toString('utf8');
      return {
        shellID: shellId,
        status: record.status,
        output,
        ...(record.exitCode !== undefined ? { exit: record.exitCode } : {}),
        ...(record.signal ? { signal: record.signal } : {}),
        ...(record.timeout ? { timeout: true } : {}),
        truncated: start + buffer.length < size || record.truncated,
        ...(record.status === 'error' && record.error ? { error: record.error } : {}),
      };
    } finally {
      await file.close();
    }
  }

  async run(ctx: ExtensionToolContext, input: { command: string; workdir?: string; timeout?: number; background?: boolean; shell?: string }, onSettled?: (info: JobInfo) => void): Promise<ShellOutput> {
    const command = input.command.trim();
    if (!command) throw new Error('Shell command cannot be empty');
    const cwd = resolve(ctx.cwd, input.workdir ?? '.');
    const shellId = randomUUID();
    const file = resolve(ctx.cwd, '.pi', 'shells', `${shellId}.log`);
    await mkdir(dirname(file), { recursive: true });
    const stream = createWriteStream(file, { flags: 'a' });
    await new Promise<void>((resolveReady, rejectReady) => {
      stream.once('open', () => resolveReady());
      stream.once('error', rejectReady);
    });
    const timeout = input.background ? (input.timeout ?? 0) : (input.timeout ?? DEFAULT_TIMEOUT_MS);
    const record: ShellRecord = { shellID: shellId, command, cwd, file, startedAt: Date.now(), status: 'running', output: '', truncated: false };
    this.records.set(shellId, record);
    const controller = new AbortController();
    this.running.set(shellId, controller);
    const parentSessionId = ctx.sessionManager.getSessionId();
    const recovery = { kind: 'shell' as const, parentSessionId, shellId, command };

    const info = this.jobs.start({
      id: shellId,
      type: 'shell',
      title: command,
      metadata: { cwd, file },
      recovery,
      settled: onSettled,
      run: async () => new Promise<string>((resolveRun, rejectRun) => {
        let bytes = 0;
        let tail = Buffer.alloc(0);
        const finish = (error?: Error) => {
          stream.end(() => {
            record.completedAt = Date.now();
            this.running.delete(shellId);
            this.events.changed?.(record);
            if (error) rejectRun(error);
            else resolveRun(record.output);
          });
        };
        const onData = (chunk: Buffer) => {
          bytes += chunk.length;
          stream.write(chunk);
          tail = Buffer.concat([tail, chunk]);
          if (tail.length > MEMORY_TAIL_BYTES) {
            tail = tail.subarray(tail.length - MEMORY_TAIL_BYTES);
            record.truncated = true;
          }
          record.output = tail.toString('utf8');
          this.events.changed?.(record);
        };
        void createLocalBashOperations({ shellPath: input.shell }).exec(command, cwd, {
          signal: controller.signal,
          timeout: timeout > 0 ? timeout / 1000 : undefined,
          onData,
          env: process.env,
        }).then(({ exitCode }) => {
          // OpenCode keeps exit status separate from job status: a non-zero exit is still an "exited"
          // shell whose result text reports the code. Only a timeout or an abort is a failure.
          record.exitCode = exitCode ?? undefined;
          record.status = controller.signal.aborted ? 'cancelled' : 'completed';
          finish(record.status === 'cancelled' ? new Error('Command cancelled') : undefined);
        }, (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          const timedOut = /^timeout:/i.test(message);
          record.status = controller.signal.aborted ? 'cancelled' : 'error';
          record.timeout = timedOut;
          record.error = timedOut ? shellNotice({ timeout: true }) : message;
          finish(new Error(record.error));
        });
      }),
    });

    if (input.background) {
      this.jobs.background(info.id);
      return { shellID: shellId, status: 'running', output: `Command moved to the background (shell ID: ${shellId}).\nOutput is streaming to: ${file}\n\n${BACKGROUND_INSTRUCTION}`, truncated: false };
    }

    const blocked = await this.jobs.block(info.id, parentSessionId);
    if (blocked?.type === 'backgrounded') return { shellID: shellId, status: 'running', output: `Command moved to the background (shell ID: ${shellId}).\nOutput is streaming to: ${file}\n\n${BACKGROUND_INSTRUCTION}`, truncated: false };
    if (blocked?.info.status === 'error') throw new Error(blocked.info.error ?? record.error ?? 'Command failed');
    if (blocked?.info.status === 'cancelled') throw new Error('Command cancelled');
    return this.output(shellId, 0, 1024 * 1024);
  }

  async cancel(shellId: string): Promise<JobInfo | undefined> {
    this.running.get(shellId)?.abort();
    const info = await this.jobs.cancel(shellId);
    const record = this.records.get(shellId);
    if (record && record.status === 'running') {
      record.status = 'cancelled';
      record.completedAt = Date.now();
      this.events.changed?.(record);
    }
    return info;
  }
}

export interface ChildSessionRecord {
  sessionId: string;
  description: string;
  agent: 'explore' | 'general';
  status: 'running' | 'completed' | 'error' | 'cancelled';
  startedAt: number;
  completedAt?: number;
  model?: string;
  result?: string;
  error?: string;
  lastPrompt?: string;
  thinking?: string;
  tools: ToolRecord[];
  parentSessionId: string;
  fresh: boolean;
  run: (prompt: string) => Promise<string>;
  abort: () => Promise<void>;
}

export interface SubagentEvents {
  changed?: (record: ChildSessionRecord) => void;
  completed?: (record: ChildSessionRecord) => void;
}

export type { ShellOutput, ShellRecord } from './types.js';

export type SpawnSubagentInput = SubagentInput;

export class SubagentManager {
  private readonly children = new Map<string, ChildSessionRecord>();
  private readonly sessions = new Map<string, Awaited<ReturnType<typeof createAgentSession>>['session']>();
  private readonly persistableSessions = new Set<string>();
  private readonly running = new Map<string, AbortController>();
  private readonly depths = new Map<string, number>();
  private readonly limit = 1;

  constructor(private readonly jobs: JobRegistry, private readonly events: SubagentEvents = {}) {}

  list(): ChildSessionRecord[] {
    return [...this.children.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(sessionId: string): ChildSessionRecord | undefined {
    return this.children.get(sessionId);
  }

  async spawn(ctx: ExtensionToolContext, input: SpawnSubagentInput): Promise<{ sessionId: string; status: 'running' | 'completed'; output: string }> {
    const agent = input.agent;
    const parentSessionId = ctx.sessionManager.getSessionId();
    const parentDepth = this.depths.get(parentSessionId) ?? 0;
    if (parentDepth >= this.limit) throw new Error(`Subagent depth limit reached (${this.limit}).`);

    const childSessionId = input.sessionID;
    let child = childSessionId ? this.children.get(childSessionId) : undefined;
    if (childSessionId && !child) child = await this.resumeChild(ctx, childSessionId);
    if (childSessionId && !child) throw new Error(`Subagent session not found: ${childSessionId}`);
    if (child && child.parentSessionId !== parentSessionId) throw new Error(`Session ${childSessionId} is not a child of the current session`);
    if (child && child.agent !== agent) throw new Error(`Session ${childSessionId} is not configured for agent ${agent}.`);
    if (!child) child = await this.createChild(ctx, input.description, agent, input.model, parentDepth + 1);
    else if (input.model) {
      const [provider, ...rest] = input.model.split('/');
      const selected = ctx.modelRegistry.find(provider!, rest.join('/'));
      if (!selected) throw new Error(`Model is unavailable: ${input.model}`);
      const session = this.sessions.get(child.sessionId);
      if (session) await session.setModel(selected);
    }

    const controller = this.running.get(child.sessionId) ?? new AbortController();
    this.running.set(child.sessionId, controller);
    child.status = 'running';
    child.error = undefined;
    const recovery = { kind: 'subagent' as const, parentSessionId, childSessionId: child.sessionId, agent, description: child.description };
    const prompt = child.fresh ? `${FRESH_PROMPT}\n${input.prompt}` : input.prompt;
    child.fresh = false;

    const job = this.jobs.start({
      id: child.sessionId,
      type: 'subagent',
      title: child.description,
      metadata: { agent },
      recovery,
      run: async () => {
        const result = await child!.run(prompt);
        return result;
      },
      settled: (info) => {
        if (info.status === 'error') {
          child!.status = 'error';
          child!.error = info.error;
          child!.completedAt = info.completedAt;
          this.events.changed?.(child!);
        } else if (info.status === 'cancelled') {
          child!.status = 'cancelled';
          child!.completedAt = info.completedAt;
          this.events.changed?.(child!);
        } else if (info.status === 'completed' && child!.status !== 'completed') {
          child!.status = 'completed';
          child!.completedAt = info.completedAt;
          child!.result = info.output;
          this.events.changed?.(child!);
        }
        this.events.completed?.(child!);
      },
    });

    if (input.background) {
      this.jobs.background(job.id);
      return {
        sessionId: child.sessionId,
        status: 'running',
        output: `The subagent is working in the background (sessionID: ${child.sessionId}). You will be notified automatically when it finishes.\nDO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.\nWork on non-overlapping tasks, or briefly tell the user what you launched and end your response.`,
      };
    }

    const blocked = await this.jobs.block(job.id, parentSessionId);
    if (blocked?.type === 'backgrounded') return { sessionId: child.sessionId, status: 'running', output: `The subagent is working in the background (sessionID: ${child.sessionId}). You will be notified automatically when it finishes.\nDO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.\nWork on non-overlapping tasks, or briefly tell the user what you launched and end your response.` };
    // OpenCode returns the sessionID on failure surfaces so the model can continue the child.
    if (blocked?.info.status === 'error') throw new Error(`Subagent failed (sessionID: ${child.sessionId}): ${blocked.info.error ?? 'unknown error'}`);
    if (blocked?.info.status === 'cancelled') throw new Error(`Subagent cancelled (sessionID: ${child.sessionId})`);
    return { sessionId: child.sessionId, status: 'completed', output: blocked?.info.output ?? SUBAGENT_NO_TEXT };
  }

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
    const metadata = sessionManager.getEntries().find((entry) => entry.type === 'custom' && entry.customType === 'pi-agent-orchestrator.child') as { data?: { agent?: 'explore' | 'general'; description?: string; model?: { provider: string; id: string } } } | undefined;
    const saved = metadata?.data;
    if (!saved?.agent) return undefined;
    const agent = saved.agent;
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
    const model = saved?.model ? ctx.modelRegistry.find(saved.model.provider, saved.model.id) : ctx.model;
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, ...(agent === 'explore' ? { systemPrompt: EXPLORE_PROMPT } : {}) });
    await resourceLoader.reload();
    const childSession = await createAgentSession({ cwd, agentDir, model, thinkingLevel: ctx.thinkingLevel ?? 'medium', sessionManager, settingsManager, resourceLoader, tools: agent === 'explore' ? ['read', 'grep', 'find', 'ls', 'bash'] : ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] });
    const session = childSession.session;
    const lastUser = [...sessionManager.getEntries()].reverse().find((entry) => entry.type === 'message' && entry.message.role === 'user');
    const child: ChildSessionRecord = {
      sessionId: session.sessionId,
      fresh: false,
      lastPrompt: lastUser?.type === 'message' && 'content' in lastUser.message ? (typeof lastUser.message.content === 'string' ? lastUser.message.content : lastUser.message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')) : '',
      description: saved?.description ?? info.name ?? 'Subagent',
      agent,
      status: 'completed',
      startedAt: info.created.getTime(),
      completedAt: info.modified.getTime(),
      model: model?.id,
      tools: [],
      parentSessionId: ctx.sessionManager.getSessionId(),
      run: async (prompt) => {
        child.lastPrompt = prompt;
        child.thinking = '';
        session.setActiveToolsByName(agent === 'explore' ? ['read', 'grep', 'find', 'ls', 'bash'] : ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
        const unsubscribe = session.subscribe((event) => {
          if (event.type === 'message_update' && event.assistantMessageEvent.type === 'thinking_delta') { child.thinking = (child.thinking ?? '') + event.assistantMessageEvent.delta; this.events.changed?.(child); }
          else if (event.type === 'tool_execution_start') { child.tools.push({ name: event.toolName, input: event.args, startedAt: Date.now(), status: 'running' }); this.events.changed?.(child); }
          else if (event.type === 'tool_execution_end') { const tool = child.tools.findLast((entry) => entry.name === event.toolName && entry.status === 'running'); if (tool) { tool.completedAt = Date.now(); tool.status = event.isError ? 'error' : 'completed'; } this.events.changed?.(child); }
        });
        try {
          await session.prompt(prompt);
          const last = [...session.messages].reverse().find((message) => message.role === 'assistant');
          return last?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') || session.getLastAssistantText() || SUBAGENT_NO_TEXT;
        } finally { unsubscribe(); }
      },
      abort: async () => { await session.abort(); child.status = 'cancelled'; this.events.changed?.(child); },
    };
    this.sessions.set(sessionId, session);
    this.children.set(sessionId, child);
    if (session.sessionFile) this.persistableSessions.add(sessionId);
    this.events.changed?.(child);
    return child;
  }

  private async createChild(ctx: ExtensionToolContext, description: string, agent: 'explore' | 'general', modelRef: string | undefined, depth: number): Promise<ChildSessionRecord> {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
    let model = ctx.model;
    if (modelRef) {
      const [provider, ...rest] = modelRef.split('/');
      const resolved = ctx.modelRegistry.find(provider!, rest.join('/'));
      if (!resolved) throw new Error(`Model is unavailable: ${modelRef}`);
      model = resolved;
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      ...(agent === 'explore' ? { systemPrompt: EXPLORE_PROMPT } : {}),
    });
    await resourceLoader.reload();
    const parentSessionFile = ctx.sessionManager.getSessionFile();
    const childManager = parentSessionFile
      ? SessionManager.create(ctx.cwd, undefined, { parentSession: parentSessionFile })
      : SessionManager.inMemory(ctx.cwd);
    if (parentSessionFile) childManager.appendCustomEntry('pi-agent-orchestrator.child', { agent, description, model: model ? { provider: model.provider, id: model.id } : undefined });
    const childSession = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      model,
      thinkingLevel: ctx.thinkingLevel ?? 'medium',
      sessionManager: childManager,
      settingsManager,
      resourceLoader,
      tools: agent === 'explore' ? ['read', 'grep', 'find', 'ls', 'bash'] : ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    });
    const session = childSession.session;
    if (model && (session.model?.provider !== model.provider || session.model?.id !== model.id)) await session.setModel(model);
    const child: ChildSessionRecord = {
      sessionId: session.sessionId,
      description,
      agent,
      status: 'running',
      startedAt: Date.now(),
      model: model?.id,
      tools: [],
      parentSessionId: ctx.sessionManager.getSessionId(),
      fresh: true,
      run: async (prompt) => {
        child.lastPrompt = prompt;
        child.thinking = '';
        const allowed = agent === 'explore' ? ['read', 'grep', 'find', 'ls', 'bash'] : ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
        session.setActiveToolsByName(allowed);
        const unsubscribe = session.subscribe((event) => {
          if (event.type === 'message_update' && event.assistantMessageEvent.type === 'thinking_delta') {
            child.thinking = (child.thinking ?? '') + event.assistantMessageEvent.delta;
            this.events.changed?.(child);
          } else if (event.type === 'tool_execution_start') {
            const record: ToolRecord = { name: event.toolName, input: event.args, startedAt: Date.now(), status: 'running' };
            child.tools.push(record);
            this.events.changed?.(child);
          } else if (event.type === 'tool_execution_end') {
            const record = child.tools.findLast((item) => item.name === event.toolName && item.status === 'running');
            if (record) {
              record.completedAt = Date.now();
              record.status = event.isError ? 'error' : 'completed';
              const text = event.result?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
              if (text) record.output = text;
              if (event.result?.details?.fullOutputPath) record.output += `\nFull output: ${event.result.details.fullOutputPath}`;
              if (event.result?.structuredContent?.full_output_path) record.output += `\nFull output: ${event.result.structuredContent.full_output_path}`;
            }
            this.events.changed?.(child);
          }
        });
        try {
          await session.prompt(prompt);
          const last = [...session.messages].reverse().find((message) => message.role === 'assistant');
          const text = last?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).filter(Boolean).join('\n\n');
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
      },
      abort: async () => {
        this.running.get(session.sessionId)?.abort();
        await session.abort();
        child.status = 'cancelled';
        child.completedAt = Date.now();
        this.events.changed?.(child);
      },
    };
    this.sessions.set(session.sessionId, session);
    if (session.sessionFile) this.persistableSessions.add(session.sessionId);
    this.depths.set(session.sessionId, depth);
    this.children.set(session.sessionId, child);
    this.events.changed?.(child);
    return child;
  }

  async abort(sessionId: string): Promise<void> {
    const child = this.children.get(sessionId);
    if (!child) return;
    await child.abort();
    await this.jobs.cancel(sessionId);
  }
}
