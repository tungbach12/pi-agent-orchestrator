import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import { matchesKey, Text, type EditorComponent, type TUI } from '@earendil-works/pi-tui';
import { ActivityDocument, shouldInstallEditorHook, shouldOpenActivityFromEditorInput } from './activity.js';
import { JobRegistry } from './jobs.js';
import { ShellManager } from './shell.js';
import { SubagentManager, type ChildSessionRecord } from './subagent.js';
import { shellResultText } from './shell-result.js';
import { subagentResultEnvelope } from './prompts.js';
import type { ShellRecord, ShellOutput } from './types.js';
import {
  JobBackgroundParams,
  JobCancelParams,
  JobStatusParams,
  JobWaitParams,
  ShellOutputParams,
  ShellParams,
  SubagentParams,
  type JobBackgroundInput,
  type JobCancelInput,
  type JobStatusInput,
  type JobWaitInput,
  type ShellInput,
  type ShellOutputInput,
  type SubagentInput,
} from './types.js';

type EditorFactory = NonNullable<ReturnType<ExtensionContext['ui']['getEditorComponent']>>;

/**
 * Adds background jobs and child agents to Pi.
 *
 * A command or a child agent becomes a job. Foreground jobs block the call and
 * return their result; background jobs return a receipt and report their
 * completion to the parent session on its own, so the model never has to poll.
 */
export default function agentOrchestrator(pi: ExtensionAPI): void {
  const jobs = new JobRegistry();
  let ctx: ExtensionContext | undefined;
  let activityOpen = false;
  const shellManager = new ShellManager(jobs, {
    changed: () => refresh(),
    settled: (info) => {
      refresh();
      // A backgrounded command reports itself; a foreground one already
      // returned its result to the model.
      if (info.notificationId) deliver(info);
    },
  });
  const subagents = new SubagentManager(jobs, {
    changed: () => refresh(),
    completed: (_record, info) => {
      refresh();
      // A backgrounded child reports itself; a foreground one already returned
      // its result to the model.
      if (info.notificationId) deliver(info);
    },
  });
  let previousEditorFactory: EditorFactory | undefined;
  let activityEditorFactory: EditorFactory | undefined;

  function refresh(): void {
    const current = ctx;
    if (!current) return;
    const active = jobs.list().filter((item) => item.status === 'running');
    try {
      current.ui.setStatus(
        'agent-orchestrator',
        active.length
          ? `✱ ${active.length} running job${active.length === 1 ? '' : 's'} · ↓ Activity`
          : undefined,
      );
    } catch {
      // The session was replaced or closed: drop the binding so late job
      // events stay silent instead of throwing.
      ctx = undefined;
    }
  }

  /**
   * Sends the completion notice for a backgrounded job.
   *
   * The notice is delivered as a follow-up message so the parent session picks
   * the result up without the model having to ask for it.
   */
  function deliver(info: import('./types.js').JobInfo): void {
    const recovery = info.recovery;
    if (!recovery || !info.notificationId) return;
    const result =
      info.status === 'completed'
        ? (info.output ?? 'Subagent completed without a text response.')
        : info.status === 'error'
          ? (info.error ?? 'Subagent failed')
          : 'Cancelled';
    const label = recovery.kind === 'subagent' ? recovery.description : recovery.command;
    const content =
      recovery.kind === 'subagent'
        ? `<subagent sessionID="${recovery.childSessionId}" state="${info.status}" description="${label}">\n${result}\n</subagent>`
        : result;
    try {
      pi.sendMessage(
        {
          customType: 'agent-orchestrator-completion',
          content,
          details: { ...info, result },
          display: true,
        },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
      jobs.completeBackground(info.notificationId);
    } catch {
      // The parent session is gone; a process-local job cannot outlive it.
    }
  }

  const openActivity = async (current: ExtensionContext | ExtensionToolContext) => {
    if (activityOpen) return;
    try {
      if (!current.hasUI) return;
    } catch {
      return;
    }
    activityOpen = true;
    try {
      await current.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new ActivityDocument(tui, theme, {
            shells: () => shellManager.list(),
            children: () => subagents.list(),
            cancel: (id) => {
              void subagents.abort(id).then(() => shellManager.cancel(id));
            },
            close: done,
          }),
        {
          overlay: true,
          overlayOptions: {
            anchor: 'bottom-center',
            width: '100%',
            maxHeight: '100%',
            minWidth: 60,
            margin: { left: 0, right: 0, bottom: 0 },
          },
        },
      );
    } finally {
      activityOpen = false;
      refresh();
    }
  };

  pi.on('session_start', async (_event, current) => {
    ctx = current;
    jobs.bindPersistence(
      (customType, data) => {
        try {
          pi.appendEntry(customType, data);
        } catch {
          // The session was replaced while a job was still settling.
        }
      },
      current.sessionManager
        .getEntries()
        .filter((entry) => entry.type === 'custom')
        .map((entry: any) => ({ customType: entry.customType, data: entry.data })),
    );
    refresh();
    recoverPending();

    if (shouldInstallEditorHook(current.ui.getEditorComponent(), activityEditorFactory)) {
      previousEditorFactory = current.ui.getEditorComponent();
      activityEditorFactory = (tui, editorTheme, keybindings) => {
        const editor = previousEditorFactory
          ? previousEditorFactory(tui, editorTheme, keybindings)
          : new CustomEditor(tui, editorTheme, keybindings);
        const originalHandleInput = editor.handleInput.bind(editor);
        editor.handleInput = (data: string) => {
          if (shouldOpenActivityFromEditorInput(matchesKey(data, 'down'), editor, tui)) {
            void openActivity(current);
            return;
          }
          originalHandleInput(data);
        };
        return editor;
      };
      current.ui.setEditorComponent(activityEditorFactory);
    }
  });

  /**
   * Reports jobs that were still running when Pi last stopped.
   *
   * A live process cannot survive a restart, so the receipt says the work was
   * interrupted instead of pretending it finished.
   */
  function recoverPending(): void {
    for (const item of jobs.pendingBackground()) {
      try {
        if (item.status === 'running') {
          const message =
            item.recovery.kind === 'subagent'
              ? `<subagent sessionID="${item.recovery.childSessionId}" state="cancelled" description="${item.recovery.description}">\nInterrupted because Pi restarted.\n</subagent>`
              : `Command interrupted because Pi restarted: ${item.recovery.command}`;
          pi.sendMessage(
            {
              customType: 'agent-orchestrator-completion',
              content: message,
              details: { status: 'cancelled', jobId: item.jobId, result: message },
              display: true,
            },
            { triggerTurn: false, deliverAs: 'nextTurn' },
          );
        } else {
          deliver({
            id: item.jobId,
            type: item.recovery.kind,
            title:
              item.recovery.kind === 'subagent' ? item.recovery.description : item.recovery.command,
            status: item.status,
            startedAt: item.startedAt ?? Date.now(),
            output: item.output,
            error: item.error,
            notificationId: item.notificationId,
            recovery: item.recovery,
          });
        }
      } catch {
        // The session runtime is not ready; keep the receipt for the next start.
      }
    }
  }

  pi.on('session_shutdown', async (event) => {
    if (event.reason !== 'quit') {
      // The session is being replaced. Blocking work moves to the background so
      // it still finishes, and the next session picks the result up.
      const sessionId = ctx?.sessionManager.getSessionId() ?? '';
      const backgrounded = jobs.backgroundAll(sessionId);
      if (ctx && backgrounded.length) {
        const list = backgrounded.map((job) => `- ${job.type}: ${job.title || job.id}`).join('\n');
        try {
          pi.sendMessage(
            {
              customType: 'agent-orchestrator-backgrounded',
              content: `Active work was moved to the background because this session was replaced.\n\nBackgrounded work:\n${list}\n\nThe work is unfinished. Do not report it complete or poll; wait for its completion notification.`,
              display: false,
              details: { jobs: backgrounded },
            },
            { deliverAs: 'nextTurn' },
          );
        } catch {
          // The runtime pipe is already closed.
        }
      }
      return;
    }
    ctx = undefined;
    await jobs.cancelAll();
  });

  pi.registerCommand('agents', {
    description: 'Open the jobs and subagents activity dock',
    handler: (_args, current) => openActivity(current),
  });

  pi.registerTool<typeof ShellParams, { output: ShellOutput; shellID: string; truncated: boolean }>({
    name: 'shell',
    label: 'Shell',
    description:
      'Run a shell command and return its output. Output is truncated and the full result is written to a log file. Use background=true for long commands; background commands return immediately and report their completion on their own.',
    promptSnippet: 'Run shell commands; long commands can run in the background with automatic completion notification',
    promptGuidelines: [
      'Use background=true for dev servers and long-running builds.',
      'Background commands report their completion on their own. Do not poll for it.',
    ],
    parameters: ShellParams,
    async execute(_id, input: ShellInput, _signal, _update, toolCtx) {
      const output = await shellManager.run(toolCtx, input);
      const text = shellResultText(output);
      return {
        content: [{ type: 'text', text }],
        details: { output, shellID: output.shellID, truncated: output.truncated },
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.bold('shell ')}${theme.fg('muted', args.command)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const out = result.details?.output;
      const color =
        out?.status === 'completed' ? 'success' : out?.status === 'running' ? 'warning' : 'error';
      return new Text(`${theme.fg(color, out?.status ?? 'error')} ${theme.fg('dim', out?.shellID ?? '')}`, 0, 0);
    },
  });

  pi.registerTool<typeof SubagentParams, { sessionId: string; status: string }>({
    name: 'subagent',
    label: 'Subagent',
    description:
      'Delegate a task to a child agent with its own context. The result includes a sessionID that continues the same conversation later. Foreground (default) runs the child to completion; background=true launches it and returns immediately, and the parent is notified when it finishes.',
    promptSnippet: 'Delegate a task to a child agent with isolated context; continue it later using its sessionID',
    promptGuidelines: [
      'Use background only for work that can run while you continue elsewhere.',
      'Do not sleep or poll a background subagent; the completion is delivered automatically.',
      'Pass the sessionID to continue a previous child conversation. New child sessions start with fresh context.',
    ],
    prepareLoadout(loadout) {
      const prompt =
        'The subagent type. Available agents: general (multi-step work with the full tool set); explore (read-only search specialist). Specify the desired thoroughness in the prompt.';
      return { descriptions: { subagent: `Spawns an agent in a child session. ${prompt}` } };
    },
    parameters: SubagentParams,
    async execute(_id, input: SubagentInput, _signal, _update, toolCtx) {
      const result = await subagents.spawn(toolCtx, input);
      const text =
        result.status === 'completed' ? subagentResultEnvelope(result.sessionId, result.output) : result.output;
      return {
        content: [{ type: 'text', text }],
        details: { sessionId: result.sessionId, status: result.status },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.bold('subagent ')}${theme.fg('dim', `@${args.agent ?? 'explore'} `)}${theme.fg('muted', args.description)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      return new Text(
        `${theme.fg('success', result.details?.status ?? 'completed')} ${theme.fg('dim', result.details?.sessionId ?? '')}`,
        0,
        0,
      );
    },
  });

  pi.registerTool<typeof JobStatusParams, { job?: import('./types.js').JobInfo }>({
    name: 'job_status',
    label: 'Job Status',
    description:
      'Get the current status of a shell or subagent job. Use it only when the user asks for status; a background job reports its completion on its own.',
    parameters: JobStatusParams,
    async execute(_id, input: JobStatusInput) {
      const job = jobs.get(input.id);
      return {
        content: [
          { type: 'text', text: job ? JSON.stringify(job, null, 2) : `Job not found: ${input.id}` },
        ],
        details: { job },
      };
    },
  });

  pi.registerTool<typeof JobWaitParams, { job?: import('./types.js').JobInfo; timedOut: boolean }>({
    name: 'job_wait',
    label: 'Job Wait',
    description:
      'Wait for a job to complete, or until the optional timeout. Prefer the automatic completion notice; use this only when you need the result right now.',
    parameters: JobWaitParams,
    async execute(_id, input: JobWaitInput) {
      const result = await jobs.wait(input.id, input.timeout);
      return {
        content: [
          {
            type: 'text',
            text: result.info ? JSON.stringify(result.info, null, 2) : `Job not found: ${input.id}`,
          },
        ],
        details: result,
      };
    },
  });

  pi.registerTool<typeof JobBackgroundParams, { job?: import('./types.js').JobInfo }>({
    name: 'job_background',
    label: 'Background Job',
    description: 'Move a running foreground job to the background. The parent session is notified when it finishes.',
    parameters: JobBackgroundParams,
    async execute(_id, input: JobBackgroundInput) {
      const job = jobs.background(input.id);
      return {
        content: [
          { type: 'text', text: job ? JSON.stringify(job, null, 2) : `Job not found: ${input.id}` },
        ],
        details: { job },
      };
    },
  });

  pi.registerTool<typeof JobCancelParams, { job?: import('./types.js').JobInfo }>({
    name: 'job_cancel',
    label: 'Cancel Job',
    description: 'Cancel a running shell or subagent job.',
    parameters: JobCancelParams,
    async execute(_id, input: JobCancelInput) {
      await subagents.abort(input.id);
      await shellManager.cancel(input.id);
      const job = await jobs.cancel(input.id);
      return {
        content: [
          { type: 'text', text: job ? JSON.stringify(job, null, 2) : `Job not found: ${input.id}` },
        ],
        details: { job },
      };
    },
  });

  pi.registerTool<typeof ShellOutputParams, { output: ShellOutput }>({
    name: 'shell_output',
    label: 'Shell Output',
    description:
      'Read a bounded range of a shell command output. The offset and limit are in bytes; avoid reading the same range repeatedly.',
    parameters: ShellOutputParams,
    async execute(_id, input: ShellOutputInput) {
      const output = await shellManager.output(input.shellID, input.offset, input.limit);
      return { content: [{ type: 'text', text: output.output }], details: { output } };
    },
  });

  pi.registerMessageRenderer<{ status?: string; result?: string; error?: string }>(
    'agent-orchestrator-completion',
    (message, _options, theme: Theme) => {
      const details = message.details;
      const color =
        details?.status === 'completed' ? 'success' : details?.status === 'running' ? 'warning' : 'error';
      const content = Array.isArray(message.content)
        ? message.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('\n')
        : message.content;
      return new Text(
        `${theme.fg(color, `● ${details?.status ?? 'completed'}`)} ${theme.fg('muted', details?.result ?? details?.error ?? content)}`,
        0,
        0,
      );
    },
  );
}
