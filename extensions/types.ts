import { Type, type Static } from 'typebox';

export type JobKind = 'shell' | 'subagent';
export type JobStatus = 'running' | 'completed' | 'error' | 'cancelled';
export type AgentKind = 'explore' | 'general';

export interface ShellOutput {
  exit?: number;
  signal?: string;
  shellID: string;
  output: string;
  status: JobStatus;
  timeout?: boolean;
  truncated: boolean;
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
  metadata?: Record<string, unknown>;
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
  command: Type.String({ description: 'Shell command string to execute.' }),
  workdir: Type.Optional(Type.String({ description: 'Working directory to execute in. Defaults to the current directory; when possible, avoid cd in the command and set workdir instead.' })),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in milliseconds. Foreground default is 120000; background defaults to no timeout. Use 0 to disable timeout.' })),
  background: Type.Optional(Type.Boolean({ description: 'Run in the background and return immediately. The parent session is notified automatically when the command finishes. Do not poll.' })),
});

export const SubagentParams = Type.Object({
  agent: Type.Union([Type.Literal('explore'), Type.Literal('general')], { description: 'The type of specialized child agent to use for this task. If a requested subagent name is not available, treat it as a possible model name and use the model parameter.' }),
  description: Type.String({ description: 'A short 3-5 word label for the task, displayed to the user.' }),
  prompt: Type.String({ description: 'The task for the child agent. New child sessions start with fresh context, so include relevant instructions and facts.' }),
  model: Type.Optional(Type.String({ description: 'Set only when the user explicitly asks for a particular model. Use provider/model; do not guess an ID. Defaults to the configured child-agent model, then the parent model.' })),
  sessionID: Type.Optional(Type.String({ description: 'Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.' })),
  background: Type.Optional(Type.Boolean({ description: 'Run asynchronously and return immediately. The parent is notified when complete. Do not sleep or poll.' })),
});

export const JobStatusParams = Type.Object({ id: Type.String({ description: 'Job or shell ID.' }) });
export const JobWaitParams = Type.Object({ id: Type.String({ description: 'Job or shell ID.' }), timeout: Type.Optional(Type.Number({ description: 'Optional timeout in milliseconds.' })) });
export const JobBackgroundParams = Type.Object({ id: Type.String({ description: 'Job ID to move to background.' }) });
export const JobCancelParams = Type.Object({ id: Type.String({ description: 'Job ID to cancel.' }) });
export const ShellOutputParams = Type.Object({ shellID: Type.String({ description: 'Shell ID returned by the shell tool.' }), offset: Type.Optional(Type.Number({ description: 'Starting byte offset.' })), limit: Type.Optional(Type.Number({ description: 'Maximum output bytes to return.' })) });

export type ShellInput = Static<typeof ShellParams>;
export type SubagentInput = Static<typeof SubagentParams>;
export type JobStatusInput = Static<typeof JobStatusParams>;
export type JobWaitInput = Static<typeof JobWaitParams>;
export type JobBackgroundInput = Static<typeof JobBackgroundParams>;
export type JobCancelInput = Static<typeof JobCancelParams>;
export type ShellOutputInput = Static<typeof ShellOutputParams>;
