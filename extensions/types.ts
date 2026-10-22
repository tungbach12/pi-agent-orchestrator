import { Type, type Static } from 'typebox';

/** A running command or child agent. */
export type JobKind = 'shell' | 'subagent';
export type JobStatus = 'running' | 'completed' | 'error' | 'cancelled';

/**
 * Child agent roles.
 *
 * `explore` is read-only: it gets Pi's search tools and no shell, so it cannot
 * change anything. `general` gets the full coding tool set.
 */
export type AgentKind = 'explore' | 'general';

/** Which Pi tools a child agent may use. */
export const AGENT_TOOLS: Record<AgentKind, readonly string[]> = {
  explore: ['read', 'grep', 'find', 'ls', 'bash'],
  general: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
};

export interface ShellOutput {
  shellID: string;
  output: string;
  status: JobStatus;
  exit?: number;
  signal?: string;
  timeout?: boolean;
  truncated: boolean;
  /** Path of the log file holding the full output. */
  file: string;
}

export interface JobInfo {
  id: string;
  type: JobKind;
  title: string;
  status: JobStatus;
  startedAt: number;
  completedAt?: number;
  output?: string;
  error?: string;
  /** Set once the job runs in the background and needs a completion notice. */
  notificationId?: string;
  recovery?:
    | { kind: 'shell'; parentSessionId: string; shellId: string; command: string }
    | { kind: 'subagent'; parentSessionId: string; childSessionId: string; agent: AgentKind; description: string };
}

export interface ShellRecord {
  shellID: string;
  command: string;
  cwd: string;
  file: string;
  startedAt: number;
  completedAt?: number;
  status: JobStatus;
  output: string;
  exitCode?: number;
  signal?: string;
  error?: string;
  timeout?: boolean;
  truncated: boolean;
}

export interface ToolRecord {
  name: string;
  input: unknown;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'completed' | 'error';
  output?: string;
}

export interface ChildRecord {
  sessionId: string;
  parentSessionId: string;
  description: string;
  agent: AgentKind;
  status: JobStatus;
  startedAt: number;
  completedAt?: number;
  tools: ToolRecord[];
  result?: string;
  error?: string;
  model?: string;
}

export const ShellParams = Type.Object({
  command: Type.String({ description: 'Shell command to execute.' }),
  workdir: Type.Optional(Type.String({ description: 'Working directory. Defaults to the current directory; prefer this over cd.' })),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in milliseconds. Foreground default is 120000; background defaults to no timeout. Use 0 to disable.' })),
  background: Type.Optional(Type.Boolean({ description: 'Run in the background and return immediately. The parent is notified on completion. Do not poll.' })),
});

export const SubagentParams = Type.Object({
  agent: Type.Union([Type.Literal('explore'), Type.Literal('general')], { description: 'The child agent type. "explore" is a read-only search specialist; "general" does multi-step work.' }),
  description: Type.String({ description: 'A short 3-5 word label for the task, shown to the user.' }),
  prompt: Type.String({ description: 'The task for the child agent. Child sessions start with fresh context, so include everything it needs.' }),
  model: Type.Optional(Type.String({ description: 'Set only when the user explicitly asks for a particular model. Use provider/model; do not guess an ID. Defaults to the configured child-agent model, then the parent model.' })),
  sessionID: Type.Optional(Type.String({ description: 'Continue a previous child conversation by passing its sessionID. Omit to start a new one.' })),
  background: Type.Optional(Type.Boolean({ description: 'Run asynchronously and return immediately. The parent is notified on completion. Do not sleep or poll.' })),
});

export const JobStatusParams = Type.Object({ id: Type.String({ description: 'Job or shell ID.' }) });
export const JobWaitParams = Type.Object({
  id: Type.String({ description: 'Job or shell ID.' }),
  timeout: Type.Optional(Type.Number({ description: 'Optional timeout in milliseconds.' })),
});
export const JobBackgroundParams = Type.Object({ id: Type.String({ description: 'Job ID to move to background.' }) });
export const JobCancelParams = Type.Object({ id: Type.String({ description: 'Job ID to cancel.' }) });
export const ShellOutputParams = Type.Object({
  shellID: Type.String({ description: 'Shell ID returned by the shell tool.' }),
  offset: Type.Optional(Type.Number({ description: 'Starting byte offset.' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum bytes to return.' })),
});

export type ShellInput = Static<typeof ShellParams>;
export type SubagentInput = Static<typeof SubagentParams>;
export type JobStatusInput = Static<typeof JobStatusParams>;
export type JobWaitInput = Static<typeof JobWaitParams>;
export type JobBackgroundInput = Static<typeof JobBackgroundParams>;
export type JobCancelInput = Static<typeof JobCancelParams>;
export type ShellOutputInput = Static<typeof ShellOutputParams>;
