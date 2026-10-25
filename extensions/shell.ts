import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createLocalBashOperations, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { JobRegistry } from './jobs.js';
import { BACKGROUND_INSTRUCTION, isServerCommand, shellNotice, truncateHeadTail } from './shell-result.js';
import type { JobInfo, ShellOutput, ShellRecord } from './types.js';

export { BACKGROUND_INSTRUCTION, isServerCommand, shellNotice, truncateHeadTail } from './shell-result.js';

/** Foreground commands give up after this long unless the caller says otherwise. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Startup window before a recognized dev-server/watcher command is auto-backgrounded. */
export const SERVER_STARTUP_GRACE_MS = 1_500;
/** How much output is kept in memory for the model-facing result. */
const MEMORY_TAIL_BYTES = 64 * 1024;
/** Maximum inline bytes returned by a foreground command before head-tail slicing. */
const MAX_INLINE_BYTES = 32 * 1024;
const HEAD_INLINE_BYTES = 12 * 1024;
const TAIL_INLINE_BYTES = 20 * 1024;
/** Upper bound for a single shell_output read. */
const MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_READ_BYTES = 16 * 1024;
const SHELLS_ENTRY = 'pi-agent-orchestrator.shells.v1';
const PERSISTED_SHELL_LIMIT = 50;
const PERSISTED_OUTPUT_CHARS = 8 * 1024;

export interface ShellEvents {
  changed?: (record: ShellRecord) => void;
  /** Fired after the job acquires an execution slot. */
  started?: (info: JobInfo) => void;
  /** Fired once the job reached a terminal state. */
  settled?: (info: JobInfo) => void;
}

/**
 * Runs shell commands in the background or the foreground.
 *
 * Output always streams to a log file under `.pi/shells/`, so a background job
 * keeps a durable record even though the process itself is local to Pi.
 */
export class ShellManager {
  readonly jobs: JobRegistry;
  private readonly records = new Map<string, ShellRecord>();
  private readonly running = new Map<string, AbortController>();
  private persist?: (customType: string, data: unknown) => void;

  constructor(jobs: JobRegistry, private events: ShellEvents = {}) {
    this.jobs = jobs;
  }

  setEvents(events: ShellEvents): void {
    this.events = events;
  }

  bindPersistence(
    appendEntry: (customType: string, data: unknown) => void,
    entries: Array<{ customType: string; data?: unknown }>,
    parentSessionId?: string,
    cwd?: string,
  ): void {
    this.persist = appendEntry;
    const restored = [...entries]
      .reverse()
      .find((entry) => entry.customType === SHELLS_ENTRY)?.data as
      | { shells?: ShellRecord[] }
      | undefined;

    for (const item of restored?.shells ?? []) {
      if (!item?.shellID) continue;
      // Preserve live in-memory running records across /reload or session switch.
      if (this.running.has(item.shellID) && this.records.has(item.shellID)) continue;
      const status =
        item.status === 'running' || item.status === 'queued' ? 'cancelled' : item.status;
      this.records.set(item.shellID, {
        ...item,
        parentSessionId: item.parentSessionId ?? parentSessionId,
        status,
        completedAt: item.completedAt ?? Date.now(),
      });
    }

    // Backfill from pi-agent-orchestrator.recovery.v1 for sessions recorded before shells.v1.
    const recoveryData = [...entries]
      .reverse()
      .find((entry) => entry.customType === 'pi-agent-orchestrator.recovery.v1')?.data as
      | { consumed?: JobInfo[] }
      | undefined;
    for (const job of recoveryData?.consumed ?? []) {
      if (job.type !== 'shell' || this.records.has(job.id)) continue;
      const shellId = job.recovery?.kind === 'shell' ? job.recovery.shellId : job.id;
      if (this.records.has(shellId)) continue;
      const command = job.recovery?.kind === 'shell' ? job.recovery.command : job.title;
      const sessionOwner = job.recovery?.parentSessionId ?? parentSessionId;
      this.records.set(shellId, {
        shellID: shellId,
        parentSessionId: sessionOwner,
        command,
        cwd: cwd ?? '.',
        file: resolve(cwd ?? '.', '.pi', 'shells', `${shellId}.log`),
        startedAt: job.startedAt,
        completedAt: job.completedAt ?? Date.now(),
        status: job.status === 'running' || job.status === 'queued' ? 'cancelled' : job.status,
        output: job.output ?? '',
        error: job.error,
        truncated: false,
      });
    }
  }

  private persistRecords(parentSessionId?: string): void {
    if (!this.persist) return;
    const shells = this.list(parentSessionId)
      .slice(0, PERSISTED_SHELL_LIMIT)
      .map((item) => ({
        ...item,
        output:
          item.output.length > PERSISTED_OUTPUT_CHARS
            ? item.output.slice(-PERSISTED_OUTPUT_CHARS)
            : item.output,
      }));
    this.persist(SHELLS_ENTRY, { version: 1, shells });
  }

  list(parentSessionId?: string): ShellRecord[] {
    return [...this.records.values()]
      .filter((r) => !parentSessionId || !r.parentSessionId || r.parentSessionId === parentSessionId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(shellId: string): ShellRecord | undefined {
    return this.records.get(shellId);
  }

  /** Reads a bounded byte range from a command's log file. */
  async output(shellId: string, offset = 0, limit = DEFAULT_READ_BYTES): Promise<ShellOutput> {
    const record = this.records.get(shellId);
    if (!record) throw new Error(`Unknown shell ID: ${shellId}`);
    const file = await open(record.file, 'r').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!file) {
      return { shellID: shellId, status: record.status, output: '', truncated: false, file: record.file };
    }
    try {
      const size = (await file.stat()).size;
      const rawOffset = Math.floor(offset);
      const start = rawOffset < 0 ? Math.max(0, size + rawOffset) : Math.max(0, Math.min(size, rawOffset));
      const length = Math.max(1, Math.min(MAX_READ_BYTES, Math.floor(limit)));
      const buffer = Buffer.alloc(Math.min(length, Math.max(0, size - start)));
      if (buffer.length) await file.read(buffer, 0, buffer.length, start);
      return {
        shellID: shellId,
        status: record.status,
        output: buffer.toString('utf8'),
        ...(record.exitCode !== undefined ? { exit: record.exitCode } : {}),
        ...(record.signal ? { signal: record.signal } : {}),
        ...(record.timeout ? { timeout: true } : {}),
        truncated: start > 0 || start + buffer.length < size || record.truncated,
        file: record.file,
      };
    } finally {
      await file.close();
    }
  }

  /** Reads bounded head-tail inline output for a completed foreground command. */
  private async inlineOutput(shellId: string): Promise<ShellOutput> {
    const record = this.records.get(shellId);
    if (!record) throw new Error(`Unknown shell ID: ${shellId}`);
    const file = await open(record.file, 'r').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!file) {
      return { shellID: shellId, status: record.status, output: '', truncated: false, file: record.file };
    }
    try {
      const size = (await file.stat()).size;
      if (size <= MAX_INLINE_BYTES) {
        const buffer = Buffer.alloc(size);
        if (size > 0) await file.read(buffer, 0, size, 0);
        return {
          shellID: shellId,
          status: record.status,
          output: buffer.toString('utf8'),
          ...(record.exitCode !== undefined ? { exit: record.exitCode } : {}),
          ...(record.signal ? { signal: record.signal } : {}),
          ...(record.timeout ? { timeout: true } : {}),
          truncated: record.truncated,
          file: record.file,
        };
      }
      const headBuf = Buffer.alloc(HEAD_INLINE_BYTES);
      const tailBuf = Buffer.alloc(TAIL_INLINE_BYTES);
      await file.read(headBuf, 0, HEAD_INLINE_BYTES, 0);
      await file.read(tailBuf, 0, TAIL_INLINE_BYTES, size - TAIL_INLINE_BYTES);
      const omitted = size - HEAD_INLINE_BYTES - TAIL_INLINE_BYTES;
      const marker = `\n\n... [truncated ${omitted} bytes; use shell_output({ shellID: "${shellId}", offset, limit }) or inspect ${record.file}] ...\n\n`;
      return {
        shellID: shellId,
        status: record.status,
        output: `${headBuf.toString('utf8')}${marker}${tailBuf.toString('utf8')}`,
        ...(record.exitCode !== undefined ? { exit: record.exitCode } : {}),
        ...(record.signal ? { signal: record.signal } : {}),
        ...(record.timeout ? { timeout: true } : {}),
        truncated: true,
        file: record.file,
      };
    } finally {
      await file.close();
    }
  }

  async run(
    ctx: ExtensionToolContext,
    input: { command: string; workdir?: string; timeout?: number; background?: boolean; shell?: string; startupGraceMs?: number },
    signal?: AbortSignal,
  ): Promise<ShellOutput> {
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

    const autoPromoteServer =
      input.background === undefined && input.timeout === undefined && isServerCommand(command);
    const timeout =
      input.background || autoPromoteServer ? (input.timeout ?? 0) : (input.timeout ?? DEFAULT_TIMEOUT_MS);
    const parentSessionId = ctx.sessionManager.getSessionId();
    const record: ShellRecord = {
      shellID: shellId,
      parentSessionId,
      command,
      cwd,
      file,
      startedAt: Date.now(),
      status: 'running',
      output: '',
      truncated: false,
    };
    this.records.set(shellId, record);
    const controller = new AbortController();
    this.running.set(shellId, controller);
    const recovery = { kind: 'shell' as const, parentSessionId, shellId, command };

    this.jobs.start({
      id: shellId,
      type: 'shell',
      title: command,
      recovery,
      started: (info) => {
        record.startedAt = info.startedAt;
        record.status = 'running';
        this.persistRecords(parentSessionId);
        this.events.started?.(info);
        this.events.changed?.(record);
      },
      cancel: () => controller.abort(),
      settled: (info) => {
        this.persistRecords(parentSessionId);
        this.events.settled?.(info);
      },
      run: async () =>
        new Promise<string>((resolveRun, rejectRun) => {
          let tail = Buffer.alloc(0);
          const finish = (error?: Error) => {
            stream.end(() => {
              record.completedAt = Date.now();
              this.running.delete(shellId);
              this.persistRecords(parentSessionId);
              this.events.changed?.(record);
              if (error) rejectRun(error);
              else resolveRun(record.output);
            });
          };
          const onData = (chunk: Buffer) => {
            stream.write(chunk);
            tail = Buffer.concat([tail, chunk]);
            if (tail.length > MEMORY_TAIL_BYTES) {
              tail = tail.subarray(tail.length - MEMORY_TAIL_BYTES);
              record.truncated = true;
            }
            record.output = tail.toString('utf8');
            this.events.changed?.(record);
          };
          void createLocalBashOperations({ shellPath: input.shell })
            .exec(command, cwd, {
              signal: controller.signal,
              timeout: timeout > 0 ? timeout / 1000 : undefined,
              onData,
            })
            .then(
              ({ exitCode }) => {
                // A non-zero exit is still a command that ran to completion; only
                // an abort or a timeout is a failure.
                record.exitCode = exitCode ?? undefined;
                record.status = controller.signal.aborted ? 'cancelled' : 'completed';
                finish(record.status === 'cancelled' ? new Error('Command cancelled') : undefined);
              },
              (error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                const timedOut = /^timeout:/i.test(message);
                record.status = controller.signal.aborted ? 'cancelled' : 'error';
                record.timeout = timedOut;
                record.error = timedOut ? shellNotice({ timeout: true }) : message;
                finish(new Error(record.error));
              },
            );
        }),
    });

    if (input.background) {
      this.jobs.background(shellId);
      return {
        shellID: shellId,
        status: 'running',
        output: `Command moved to the background (shell ID: ${shellId}).\nOutput is streaming to: ${file}`,
        truncated: false,
        file,
      };
    }

    const graceMs = input.startupGraceMs ?? SERVER_STARTUP_GRACE_MS;
    const autoPromoteTimer = autoPromoteServer
      ? setTimeout(() => {
          this.jobs.background(shellId);
        }, graceMs)
      : undefined;
    const onAbort = () => {
      const current = this.jobs.get(shellId);
      if (current && !current.notificationId) {
        void this.cancel(shellId);
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    let blocked: Awaited<ReturnType<JobRegistry['block']>>;
    try {
      blocked = await this.jobs.block(shellId, parentSessionId);
    } finally {
      if (autoPromoteTimer) clearTimeout(autoPromoteTimer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (blocked?.type === 'backgrounded') {
      const startup = record.output.trim()
        ? `\nInitial output:\n${truncateHeadTail(record.output.trim(), 2_000).text}`
        : '';
      return {
        shellID: shellId,
        status: 'running',
        output: `Command moved to the background (shell ID: ${shellId}).\nOutput is streaming to: ${file}${startup}`,
        truncated: false,
        file,
      };
    }
    if (blocked?.info.status === 'error') throw new Error(blocked.info.error ?? record.error ?? 'Command failed');
    if (blocked?.info.status === 'cancelled') throw new Error('Command cancelled');
    return this.inlineOutput(shellId);
  }

  async cancel(shellId: string): Promise<JobInfo | undefined> {
    this.running.get(shellId)?.abort();
    const info = await this.jobs.cancel(shellId);
    const record = this.records.get(shellId);
    if (record && (record.status === 'running' || record.status === 'queued')) {
      record.status = 'cancelled';
      record.completedAt = Date.now();
      this.persistRecords(record.parentSessionId);
      this.events.changed?.(record);
    }
    return info;
  }
}
