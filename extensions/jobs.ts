import { randomUUID } from 'node:crypto';
import type { JobInfo, JobStatus } from './types.js';

/** Maximum number of child agent sessions executing at the same time. */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 10;

export interface JobStartOptions {
  id: string;
  type: JobInfo['type'];
  title: string;
  recovery?: JobInfo['recovery'];
  run: () => Promise<string>;
  /** Called after the job acquires an execution slot. */
  started?: (info: JobInfo) => void;
  /** Stops the underlying command or child session. */
  cancel?: () => void | Promise<void>;
  /** Called once the job reaches a terminal state. */
  settled?: (info: JobInfo) => void;
}

interface ActiveJob {
  info: JobInfo;
  promise: Promise<JobInfo>;
  resolve: (info: JobInfo) => void;
  resolveBackgrounded: (info: JobInfo) => void;
  backgrounded: Promise<JobInfo>;
  blockingSessions: Map<string, number>;
  isBackgrounded: boolean;
  slotHeld: boolean;
  cancelRequested: boolean;
  cancelReason?: string;
  run: () => Promise<string>;
  started?: (info: JobInfo) => void;
  cancel?: () => void | Promise<void>;
  settled?: (info: JobInfo) => void;
}

const CONSUMED_LIMIT = 50;
const RECOVERY_ENTRY = 'pi-agent-orchestrator.recovery.v1';

type Recoverable = {
  jobId: string;
  notificationId: string;
  recovery: NonNullable<JobInfo['recovery']>;
  status: JobStatus;
  startedAt?: number;
  output?: string;
  error?: string;
};

/**
 * Process-local registry of queued and running commands and child agents.
 *
 * Active execution is bounded. Background jobs keep running in this Pi process
 * and report completion to their parent; recovery entries record what Pi must
 * report as interrupted if the process stops before delivery.
 */
export class JobRegistry {
  readonly maxConcurrentAgents: number;
  private jobs = new Map<string, ActiveJob>();
  private queue: ActiveJob[] = [];
  private activeAgents = 0;
  private consumed: JobInfo[] = [];
  private recoverable = new Map<string, Recoverable>();
  private recovered = new Set<string>();
  private persist?: (customType: string, data: unknown) => void;

  constructor(maxConcurrentAgents = DEFAULT_MAX_CONCURRENT_AGENTS) {
    if (!Number.isInteger(maxConcurrentAgents) || maxConcurrentAgents < 1) {
      throw new Error('maxConcurrentAgents must be a positive integer');
    }
    this.maxConcurrentAgents = maxConcurrentAgents;
  }

  get maxConcurrent(): number {
    return this.maxConcurrentAgents;
  }

  bindPersistence(
    appendEntry: (customType: string, data: unknown) => void,
    entries: Array<{ customType: string; data?: unknown }>,
  ): void {
    this.persist = appendEntry;
    const restored = [...entries]
      .reverse()
      .find((entry) => entry.customType === RECOVERY_ENTRY)?.data as
      | { recoverable?: Recoverable[]; consumed?: JobInfo[] }
      | undefined;
    // Rebinding occurs when Pi switches sessions in the same process. Preserve
    // in-memory receipts for jobs that are still alive; merge the new session's
    // persisted receipts rather than clearing them.
    for (const item of restored?.recoverable ?? []) {
      this.recoverable.set(item.notificationId, item);
      if (!this.jobs.has(item.jobId)) this.recovered.add(item.notificationId);
    }
    const consumed = new Map(this.consumed.map((job) => [job.id, job]));
    for (const job of restored?.consumed ?? []) consumed.set(job.id, job);
    this.consumed = [...consumed.values()].slice(-CONSUMED_LIMIT);
  }

  get(id: string): JobInfo | undefined {
    return this.jobs.get(id)?.info ?? this.consumed.find((job) => job.id === id);
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((job) => job.info).sort((a, b) => b.startedAt - a.startedAt);
  }

  start(input: JobStartOptions): JobInfo {
    const existing = this.jobs.get(input.id);
    if (existing && this.isPending(existing.info.status)) return existing.info;

    let resolve!: (info: JobInfo) => void;
    const promise = new Promise<JobInfo>((complete) => {
      resolve = complete;
    });
    let resolveBackgrounded!: (info: JobInfo) => void;
    const backgrounded = new Promise<JobInfo>((complete) => {
      resolveBackgrounded = complete;
    });
    const isSubagent = input.type === 'subagent';
    const startsImmediately = !isSubagent || this.activeAgents < this.maxConcurrentAgents;

    const info: JobInfo = {
      id: input.id,
      type: input.type,
      title: input.title,
      status: startsImmediately ? 'running' : 'queued',
      startedAt: Date.now(),
      recovery: input.recovery,
    };
    const active: ActiveJob = {
      info,
      promise,
      resolve,
      resolveBackgrounded,
      backgrounded,
      blockingSessions: new Map(),
      isBackgrounded: false,
      slotHeld: isSubagent && startsImmediately,
      cancelRequested: false,
      run: input.run,
      started: input.started,
      cancel: input.cancel,
      settled: input.settled,
    };

    this.jobs.set(input.id, active);

    if (startsImmediately) {
      if (active.slotHeld) this.activeAgents++;
      this.execute(active);
    } else {
      this.queue.push(active);
    }

    return info;
  }

  async wait(id: string, timeout?: number): Promise<{ info?: JobInfo; timedOut: boolean }> {
    const job = this.jobs.get(id);
    if (!job) return { timedOut: false };
    if (!this.isPending(job.info.status)) return { info: job.info, timedOut: false };
    if (timeout === undefined) return { info: await job.promise, timedOut: false };
    if (timeout <= 0) return { info: job.info, timedOut: true };
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      job.promise.then((info) => ({ info, timedOut: false as const })),
      new Promise<{ info: JobInfo; timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ info: job.info, timedOut: true }), timeout);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return result;
  }

  /** Waits until a job finishes or the foreground caller backgrounds it. */
  async block(
    id: string,
    sessionId: string,
  ): Promise<{ type: 'finished' | 'backgrounded'; info: JobInfo } | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (!this.isPending(job.info.status)) {
      this.consume(job);
      return { type: 'finished', info: job.info };
    }
    if (job.isBackgrounded) return { type: 'backgrounded', info: job.info };
    job.blockingSessions.set(sessionId, (job.blockingSessions.get(sessionId) ?? 0) + 1);
    try {
      const result = await Promise.race([
        job.promise.then((info) => ({ type: 'finished' as const, info })),
        job.backgrounded.then((info) => ({ type: 'backgrounded' as const, info })),
      ]);
      if (result.type === 'finished') this.consume(job);
      return result;
    } finally {
      const count = job.blockingSessions.get(sessionId) ?? 0;
      if (count <= 1) job.blockingSessions.delete(sessionId);
      else job.blockingSessions.set(sessionId, count - 1);
    }
  }

  /** All persisted or in-memory background receipts not yet acknowledged. */
  pendingBackground(): Recoverable[] {
    return [...this.recoverable.values()];
  }

  /** Receipts that should be replayed on session start (scoped to the active parent session when provided). */
  pendingDeliveries(parentSessionId?: string): Recoverable[] {
    return [...this.recoverable.values()].filter((item) => {
      if (parentSessionId && item.recovery.parentSessionId && item.recovery.parentSessionId !== parentSessionId) {
        return false;
      }
      if (this.recovered.has(item.notificationId)) return true;
      const live = this.jobs.get(item.jobId);
      return live !== undefined && !this.isPending(live.info.status);
    });
  }

  background(id: string): JobInfo | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.isBackgrounded) return job.info;
    job.isBackgrounded = true;
    job.blockingSessions.clear();
    if (job.info.recovery) {
      job.info.notificationId ??= randomUUID();
      this.recordRecoverable(job.info);
      this.persistRecovery();
    }
    job.resolveBackgrounded(job.info);
    return job.info;
  }

  /** Moves every job the given session is blocking into the background. */
  backgroundAll(sessionId: string, type?: JobInfo['type']): JobInfo[] {
    const output: JobInfo[] = [];
    for (const job of this.jobs.values()) {
      if (!this.isPending(job.info.status) || job.isBackgrounded) continue;
      if (type && job.info.type !== type) continue;
      if (!job.blockingSessions.has(sessionId)) continue;
      const info = this.background(job.info.id);
      if (info) output.push(info);
    }
    return output;
  }

  /** Re-attaches a running backgrounded job back to foreground blocking. */
  reattach(id: string): JobInfo | undefined {
    const job = this.jobs.get(id);
    if (!job || !this.isPending(job.info.status) || !job.isBackgrounded) return job?.info;
    job.isBackgrounded = false;
    const notificationId = job.info.notificationId;
    if (notificationId) {
      job.info.notificationId = undefined;
      this.recoverable.delete(notificationId);
      this.recovered.delete(notificationId);
      this.persistRecovery();
    }
    job.backgrounded = new Promise<JobInfo>((complete) => {
      job.resolveBackgrounded = complete;
    });
    return job.info;
  }

  async cancelAll(reason = 'Pi is shutting down; the job was interrupted.'): Promise<JobInfo[]> {
    const pendingIds = [...this.jobs.values()]
      .filter((job) => this.isPending(job.info.status))
      .map((job) => job.info.id);
    // Give foreground work the same durable receipt as background work before
    // interrupting it; otherwise a Pi quit loses its recovery path entirely.
    for (const id of pendingIds) this.background(id);
    const items = await Promise.all(pendingIds.map((id) => this.cancel(id, reason)));
    return items.filter((item): item is JobInfo => Boolean(item));
  }

  async cancel(id: string, reason?: string): Promise<JobInfo | undefined> {
    const job = this.jobs.get(id);
    if (!job) return this.get(id);
    if (!this.isPending(job.info.status)) return job.info;

    job.cancelRequested = true;
    job.cancelReason = reason ?? 'Cancelled by user.';
    if (!job.slotHeld) {
      this.queue = this.queue.filter((item) => item !== job);
      try {
        await job.cancel?.();
      } catch (error) {
        job.cancelReason = `Cancellation cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.finish(job, 'cancelled', undefined, job.cancelReason);
      this.pump();
      return job.info;
    }

    try {
      await job.cancel?.();
    } catch (error) {
      job.cancelReason = `Cancellation requested; cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    // Wait for the underlying process/session to settle. Until then the job is
    // still running and retains its execution slot; it must not be reported as
    // cancelled while it can still modify files.
    return await job.promise;
  }

  /**
   * Suppresses the automatic background completion notification for a job when
   * the model explicitly cancels it via `job_cancel` and receives the result
   * directly in the tool response.
   */
  suppressNotification(id: string): void {
    const job = this.jobs.get(id);
    const notificationId = job?.info.notificationId;
    if (notificationId) {
      job.info.notificationId = undefined;
      this.recoverable.delete(notificationId);
      this.recovered.delete(notificationId);
      this.persistRecovery();
    }
  }

  /**
   * Marks a backgrounded job's completion as delivered.
   *
   * The job stays in consumed history so `job_status` can still resolve it.
   * `recoveredJob` records work interrupted by the previous Pi process, which
   * has no live ActiveJob entry to consume.
   */
  completeBackground(notificationId: string, recoveredJob?: JobInfo): void {
    for (const [id, job] of this.jobs) {
      if (job.info.notificationId !== notificationId || this.isPending(job.info.status)) continue;
      this.recoverable.delete(notificationId);
      this.recovered.delete(notificationId);
      this.jobs.delete(id);
      this.persistCompleted(job.info);
      this.persistRecovery();
      return;
    }
    this.recoverable.delete(notificationId);
    this.recovered.delete(notificationId);
    if (recoveredJob) this.persistCompleted(recoveredJob);
    this.persistRecovery();
  }

  private execute(job: ActiveJob): void {
    try {
      job.started?.(job.info);
    } catch (error) {
      if (job.slotHeld) {
        job.slotHeld = false;
        this.activeAgents--;
      }
      this.finish(job, 'error', undefined, `Could not start job: ${error instanceof Error ? error.message : String(error)}`);
      this.pump();
      return;
    }

    void Promise.resolve()
      .then(job.run)
      .then(
        (output) =>
          this.finish(
            job,
            job.cancelRequested ? 'cancelled' : 'completed',
            job.cancelRequested ? undefined : output,
            job.cancelReason,
          ),
        (error: unknown) =>
          this.finish(
            job,
            job.cancelRequested ? 'cancelled' : 'error',
            undefined,
            job.cancelReason ?? (error instanceof Error ? error.message : String(error)),
          ),
      )
      .finally(() => {
        if (job.slotHeld) {
          job.slotHeld = false;
          this.activeAgents--;
          job.resolve(job.info);
          this.pump();
        } else {
          job.resolve(job.info);
        }
      });
  }

  private pump(): void {
    while (this.activeAgents < this.maxConcurrentAgents && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (job.info.status !== 'queued') continue;
      job.slotHeld = true;
      this.activeAgents++;
      job.info.status = 'running';
      this.execute(job);
    }
  }

  private activeCount(): number {
    return this.activeAgents;
  }

  private isPending(status: JobStatus): boolean {
    return status === 'queued' || status === 'running';
  }

  private finish(
    job: ActiveJob,
    status: Exclude<JobStatus, 'queued' | 'running'>,
    output?: string,
    error?: string,
  ): void {
    if (!this.isPending(job.info.status)) return;
    Object.assign(job.info, {
      status,
      completedAt: Date.now(),
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    if (job.info.recovery && job.info.notificationId && job.isBackgrounded) {
      this.recordRecoverable(job.info);
      this.persistRecovery();
    } else if (job.isBackgrounded && !job.info.notificationId) {
      this.consume(job);
    }
    job.resolve(job.info);
    job.settled?.(job.info);
  }

  private recordRecoverable(info: JobInfo): void {
    if (!info.recovery || !info.notificationId) return;
    this.recoverable.set(info.notificationId, {
      jobId: info.id,
      notificationId: info.notificationId,
      recovery: info.recovery,
      status: info.status,
      startedAt: info.startedAt,
      output: info.output,
      error: info.error,
    });
  }

  private persistRecovery(): void {
    this.persist?.(RECOVERY_ENTRY, {
      version: 1,
      recoverable: [...this.recoverable.values()],
      consumed: this.consumed.slice(-CONSUMED_LIMIT),
    });
  }

  private persistCompleted(job: JobInfo): void {
    this.consumed = this.consumed.filter((item) => item.id !== job.id);
    this.consumed.push(job);
    if (this.consumed.length > CONSUMED_LIMIT) this.consumed.splice(0, this.consumed.length - CONSUMED_LIMIT);
    this.persistRecovery();
  }

  private consume(job: ActiveJob): void {
    if (this.isPending(job.info.status)) return;
    if (job.info.recovery && job.info.notificationId) {
      this.recordRecoverable(job.info);
      this.persistRecovery();
    }
    if (this.jobs.delete(job.info.id)) this.persistCompleted(job.info);
  }
}
