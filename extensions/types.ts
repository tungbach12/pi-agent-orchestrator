import { Type, type Static } from 'typebox';

/** A running command or child agent. */
export type JobKind = 'shell' | 'subagent';
export type JobStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled';

/**
 * Child agent roles.
 *
 * - `explore` is a fast read-only search specialist.
 * - `code` is a focused implementation and verification specialist with the full coding tool set.
 * - `review` is a read-only code/diff auditor that reports concrete findings with file:line evidence.
 * - `research` is a read-only deep researcher for external docs/repos and local codebase investigation.
 * - `general` gets the full coding tool set with Pi's default system prompt.
 */
export const AGENT_KINDS = ['explore', 'code', 'review', 'research', 'general'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Base built-in Pi tools available to child sessions before role-based exclusions. */
export const BASE_CHILD_TOOLS = [
  'read',
  'grep',
  'find',
  'ls',
  'bash',
  'edit',
  'write',
  'codemode',
] as const;

/**
 * Tools always excluded from child sessions so children cannot recursively
 * spawn subagents/background jobs or block on interactive user prompts.
 */
export const ORCHESTRATOR_EXCLUDED_TOOLS = [
  'subagent',
  'shell',
  'job_status',
  'job_wait',
  'job_background',
  'job_cancel',
  'shell_output',
  'ask_user_question',
  'powershell',
] as const;

/**
 * Per-role tool denylist applied after inheriting all parent tools.
 *
 * Read-only roles (`explore`, `review`, `research`) exclude file-writing tools
 * (`edit`, `write`) in addition to the orchestrator tools, while `code` and
 * `general` keep `edit` and `write`.
 */
export const AGENT_EXCLUDED_TOOLS: Record<AgentKind, readonly string[]> = {
  explore: [...ORCHESTRATOR_EXCLUDED_TOOLS, 'edit', 'write'],
  code: [...ORCHESTRATOR_EXCLUDED_TOOLS],
  review: [...ORCHESTRATOR_EXCLUDED_TOOLS, 'edit', 'write'],
  research: [...ORCHESTRATOR_EXCLUDED_TOOLS, 'edit', 'write'],
  general: [...ORCHESTRATOR_EXCLUDED_TOOLS],
};

/** Built-in Pi tools enabled for each child agent role (including `codemode` for batched/scripted tool calls). */
export const AGENT_TOOLS: Record<AgentKind, readonly string[]> = {
  explore: BASE_CHILD_TOOLS.filter((tool) => !AGENT_EXCLUDED_TOOLS.explore.includes(tool)),
  code: BASE_CHILD_TOOLS.filter((tool) => !AGENT_EXCLUDED_TOOLS.code.includes(tool)),
  review: BASE_CHILD_TOOLS.filter((tool) => !AGENT_EXCLUDED_TOOLS.review.includes(tool)),
  research: BASE_CHILD_TOOLS.filter((tool) => !AGENT_EXCLUDED_TOOLS.research.includes(tool)),
  general: BASE_CHILD_TOOLS.filter((tool) => !AGENT_EXCLUDED_TOOLS.general.includes(tool)),
};

/** Whether the child agent is restricted to read-only operations. */
export function isReadOnlyAgent(agent: AgentKind): boolean {
  return agent === 'explore' || agent === 'review' || agent === 'research';
}

/** Whether the child agent can modify files and use the opt-in post-implementation review gate. */
export function isCodingAgent(agent: AgentKind): boolean {
  return agent === 'code' || agent === 'general';
}

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
  parentSessionId?: string;
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
  toolCallId?: string;
  /** Set when this tool was invoked from inside another tool (e.g. a `codemode` script). */
  parentToolCallId?: string;
  name: string;
  input: unknown;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  status: 'running' | 'completed' | 'error';
  /** Exit code captured from a shell tool result, when available. */
  exitCode?: number;
  output?: string;
  details?: unknown;
}

export interface ChildRecord {
  sessionId: string;
  parentSessionId: string;
  description: string;
  agent: AgentKind;
  status: JobStatus;
  startedAt: number;
  completedAt?: number;
  isThinking?: boolean;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
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
  agent: Type.Unsafe<AgentKind>({
    type: 'string',
    enum: [...AGENT_KINDS],
    description:
      'The child agent type: "explore" (read-only codebase search), "code" (focused implementation & verification), "review" (read-only code/diff review), "research" (read-only deep research across web, GitHub & local code), or "general" (full-tool multi-step work).',
  }),
  description: Type.String({ description: 'A short 3-5 word label for the task, shown to the user.' }),
  prompt: Type.String({ description: 'The task for the child agent. Child sessions start with fresh context, so include everything it needs.' }),
  expectedOutput: Type.Optional(
    Type.String({
      description:
        'Optional output contract specifying the exact questions, sections, file:line citations, or verification command outputs the child agent must return.',
    }),
  ),
  model: Type.Optional(Type.String({ description: 'Set only when the user explicitly asks for a particular model. Use provider/model; do not guess an ID. Defaults to the configured child-agent model, then the parent model.' })),
  sessionID: Type.Optional(Type.String({ description: 'Continue a previous child conversation by passing its sessionID. Omit to start a new one.' })),
  background: Type.Optional(Type.Boolean({ description: 'Run asynchronously and return immediately. The parent is notified on completion. Do not sleep or poll.' })),
  review: Type.Optional(Type.Boolean({ description: 'For a "code" or "general" coding task, run one independent read-only review against this task after implementation. If review finds concrete gaps, allow one bounded fix and re-review. Adds latency and token cost; does not replace running the required tests.' })),
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
  offset: Type.Optional(Type.Number({ description: 'Starting byte offset (non-negative from start of log, or negative such as -8192 to read from the end of the log).' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum bytes to return.' })),
});

export type ShellInput = Static<typeof ShellParams>;
export type SubagentInput = Static<typeof SubagentParams>;
export type JobStatusInput = Static<typeof JobStatusParams>;
export type JobWaitInput = Static<typeof JobWaitParams>;
export type JobBackgroundInput = Static<typeof JobBackgroundParams>;
export type JobCancelInput = Static<typeof JobCancelParams>;
export type ShellOutputInput = Static<typeof ShellOutputParams>;
