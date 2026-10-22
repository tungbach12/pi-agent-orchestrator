import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createLocalBashOperations, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { JobRegistry } from './jobs.js';
import { BACKGROUND_INSTRUCTION, shellNotice } from './shell-result.js';
import type { JobInfo, ShellOutput, ShellRecord } from './types.js';

export { BACKGROUND_INSTRUCTION, shellNotice } from './shell-result.js';

/** Foreground commands give up after this long unless the caller says otherwise. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** How much output is kept in memory for the model-facing result. */
const MEMORY_TAIL_BYTES = 64 * 1024;
/** Upper bound for a single shell_output read. */
const MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_READ_BYTES = 16 * 1024;

export interface ShellEvents {
  changed?: (record: ShellRecord) => void;
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

  constructor(jobs: JobRegistry, private readonly events: ShellEvents = {}) {
    this.jobs = jobs;
  }

  list(): ShellRecord[] {
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt);
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
      const start = Math.max(0, Math.min(size, Math.floor(offset)));
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
        truncated: start + buffer.length < size || record.truncated,
        file: record.file,
      };
    } finally {
      await file.close();
    }
  }

  async run(
    ctx: ExtensionToolContext,
    input: { command: string; workdir?: string; timeout?: number; background?: boolean; shell?: string },
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

    const timeout = input.background ? (input.timeout ?? 0) : (input.timeout ?? DEFAULT_TIMEOUT_MS);
    const record: ShellRecord = {
      shellID: shellId,
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
    const parentSessionId = ctx.sessionManager.getSessionId();
    const recovery = { kind: 'shell' as const, parentSessionId, shellId, command };

    this.jobs.start({
      id: shellId,
      type: 'shell',
      title: command,
      recovery,
      settled: (info) => this.events.settled?.(info),
      run: async () =>
        new Promise<string>((resolveRun, rejectRun) => {
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
      // shellResultText() adds BACKGROUND_INSTRUCTION for a running result, so the
      // receipt must not repeat it here.
      return {
        shellID: shellId,
        status: 'running',
        output: `Command moved to the background (shell ID: ${shellId}).\nOutput is streaming to: ${file}`,
        truncated: false,
        file,
      };
    }

    const blocked = await this.jobs.block(shellId, parentSessionId);
    if (blocked?.type === 'backgrounded') {
      return {
        shellID: shellId,
        status: 'running',
        output: `Command moved to the background (shell ID: ${shellId}).\nOutput is streaming to: ${file}`,
        truncated: false,
        file,
      };
    }
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
