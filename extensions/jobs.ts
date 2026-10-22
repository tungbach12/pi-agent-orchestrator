import { randomUUID } from 'node:crypto';
import type { JobInfo, JobStatus } from './types.js';

export interface JobStartOptions {
  id: string;
  type: JobInfo['type'];
  title: string;
  recovery?: JobInfo['recovery'];
  run: () => Promise<string>;
  /** Called once the job reaches a terminal state. */
  settled?: (info: JobInfo) => void;
}

interface ActiveJob {
  info: JobInfo;
  promise: Promise<JobInfo>;
  resolveBackgrounded: (info: JobInfo) => void;
  backgrounded: Promise<JobInfo>;
  blockingSessions: Map<string, number>;
  isBackgrounded: boolean;
}

const CONSUMED_LIMIT = 25;
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
 * Process-local registry of running commands and child agents.
 *
 * A job is "backgrounded" when the parent stops waiting for it. Backgrounded
 * jobs keep running in this process and report their completion to the parent
 * session; nothing here survives a Pi restart except the recovery receipt.
 */
export class JobRegistry {
  private jobs = new Map<string, ActiveJob>();
  private consumed: JobInfo[] = [];
  private recoverable = new Map<string, Recoverable>();
  private persist?: (customType: string, data: unknown) => void;

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
    for (const item of restored?.recoverable ?? []) this.recoverable.set(item.notificationId, item);
    for (const item of restored?.consumed ?? []) this.consumed.push(item);
    if (this.consumed.length > CONSUMED_LIMIT) this.consumed = this.consumed.slice(-CONSUMED_LIMIT);
  }

  get(id: string): JobInfo | undefined {
    return this.jobs.get(id)?.info ?? this.consumed.find((job) => job.id === id);
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((job) => job.info).sort((a, b) => b.startedAt - a.startedAt);
  }

  start(input: JobStartOptions): JobInfo {
    const existing = this.jobs.get(input.id);
    if (existing?.info.status === 'running') return existing.info;

    let resolveBackgrounded!: (info: JobInfo) => void;
    const backgrounded = new Promise<JobInfo>((resolve) => {
      resolveBackgrounded = resolve;
    });
    const info: JobInfo = {
      id: input.id,
      type: input.type,
      title: input.title,
      status: 'running',
      startedAt: Date.now(),
      recovery: input.recovery,
    };
    const active: ActiveJob = {
      info,
      promise: Promise.resolve(info),
      resolveBackgrounded,
      backgrounded,
      blockingSessions: new Map(),
      isBackgrounded: false,
    };
    this.jobs.set(input.id, active);

    active.promise = Promise.resolve()
      .then(input.run)
      .then((output) => this.settle(active, 'completed', output))
      .catch((error: unknown) =>
        this.settle(active, 'error', undefined, error instanceof Error ? error.message : String(error)),
      )
      .then((settled) => {
        // A backgrounded job that finishes is kept as a recovery receipt so a
        // Pi restart can still report what it produced.
        if (active.isBackgrounded && settled.recovery && settled.notificationId) {
          this.recoverable.set(settled.notificationId, {
            jobId: settled.id,
            notificationId: settled.notificationId,
            recovery: settled.recovery,
            status: settled.status,
            startedAt: settled.startedAt,
            output: settled.output,
            error: settled.error,
          });
          this.persistRecovery();
        }
        input.settled?.(settled);
        return settled;
      });

    return info;
  }

  async wait(id: string, timeout?: number): Promise<{ info?: JobInfo; timedOut: boolean }> {
    const job = this.jobs.get(id);
    if (!job) return { timedOut: false };
    if (job.info.status !== 'running') return { info: job.info, timedOut: false };
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

  /**
   * Waits for a job to finish, or returns as soon as it is backgrounded.
   *
   * The backgrounded branch matters: a foreground shell that the user moves to
   * the background must not keep the parent session blocked.
   */
  async block(id: string, sessionId: string): Promise<{ type: 'finished' | 'backgrounded'; info: JobInfo } | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.info.status !== 'running') {
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

  /** Backgrounded jobs whose completion has not been delivered yet. */
  pendingBackground(): Recoverable[] {
    return [...this.recoverable.values()];
  }

  background(id: string): JobInfo | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.isBackgrounded) return job.info;
    job.isBackgrounded = true;
    job.blockingSessions.clear();
    if (job.info.recovery) {
      job.info.notificationId ??= randomUUID();
      if (job.info.status !== 'running') {
        this.recoverable.set(job.info.notificationId, {
          jobId: job.info.id,
          notificationId: job.info.notificationId,
          recovery: job.info.recovery,
          status: job.info.status,
          startedAt: job.info.startedAt,
          output: job.info.output,
          error: job.info.error,
        });
      }
      this.persistRecovery();
    }
    job.resolveBackgrounded(job.info);
    return job.info;
  }

  /** Moves every job the given session is blocking into the background. */
  backgroundAll(sessionId: string, type?: JobInfo['type']): JobInfo[] {
    const output: JobInfo[] = [];
    for (const job of this.jobs.values()) {
      if (job.info.status !== 'running' || job.isBackgrounded) continue;
      if (type && job.info.type !== type) continue;
      if (!job.blockingSessions.has(sessionId)) continue;
      const info = this.background(job.info.id);
      if (info) output.push(info);
    }
    return output;
  }

  async cancelAll(): Promise<JobInfo[]> {
    const active = [...this.jobs.keys()].filter((id) => this.jobs.get(id)?.info.status === 'running');
    const items = await Promise.all(active.map((id) => this.cancel(id)));
    return items.filter((item): item is JobInfo => Boolean(item));
  }

  async cancel(id: string): Promise<JobInfo | undefined> {
    const job = this.jobs.get(id);
    if (!job) return this.get(id);
    if (job.info.status === 'running') {
      this.settle(job, 'cancelled');
      if (job.info.recovery && job.info.notificationId) {
        this.recoverable.set(job.info.notificationId, {
          jobId: job.info.id,
          notificationId: job.info.notificationId,
          recovery: job.info.recovery,
          status: 'cancelled',
          startedAt: job.info.startedAt,
        });
        this.persistRecovery();
      }
      void job.promise.catch(() => {});
    }
    this.consume(job);
    return job.info;
  }

  /**
   * Marks a backgrounded job's completion as delivered.
   *
   * The job stays in the consumed history so `job_status` can still resolve it
   * after the notice reached the parent session.
   */
  completeBackground(notificationId: string): void {
    for (const [id, job] of this.jobs) {
      if (job.info.notificationId === notificationId && job.info.status !== 'running') {
        this.recoverable.delete(notificationId);
        this.persistCompleted(job.info);
        this.jobs.delete(id);
        this.persistRecovery();
        return;
      }
    }
    this.recoverable.delete(notificationId);
    this.persistRecovery();
  }

  private settle(job: ActiveJob, status: Exclude<JobStatus, 'running'>, output?: string, error?: string): JobInfo {
    if (job.info.status !== 'running') return job.info;
    Object.assign(job.info, {
      status,
      completedAt: Date.now(),
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    return job.info;
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
    if (job.info.status === 'running') return;
    if (job.info.recovery && job.info.notificationId) {
      this.recoverable.set(job.info.notificationId, {
        jobId: job.info.id,
        notificationId: job.info.notificationId,
        recovery: job.info.recovery,
        status: job.info.status,
        startedAt: job.info.startedAt,
        output: job.info.output,
        error: job.info.error,
      });
      this.persistRecovery();
    }
    if (this.jobs.delete(job.info.id)) this.persistCompleted(job.info);
  }
}
