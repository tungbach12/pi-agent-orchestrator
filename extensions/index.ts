import { CustomEditor, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, Text, type EditorComponent, type TUI } from '@earendil-works/pi-tui';
import { ActivityDocument } from './activity.js';
import { JobRegistry } from './jobs.js';
import { ShellManager, SubagentManager, type ChildSessionRecord, type SpawnSubagentInput } from './shell.js';
import { shellResultText } from './shell-result.js';
import { subagentResultEnvelope } from './prompts.js';
import { shouldInstallEditorHook, shouldOpenActivityFromEditorInput } from './activity-keys.js';
import type { ShellRecord, ShellOutput } from './types.js';
import { JobBackgroundParams, JobCancelParams, JobStatusParams, JobWaitParams, ShellOutputParams, ShellParams, SubagentParams, type JobBackgroundInput, type JobCancelInput, type JobStatusInput, type JobWaitInput, type ShellInput, type ShellOutputInput } from './types.js';

type EditorFactory = NonNullable<ReturnType<ExtensionContext['ui']['getEditorComponent']>>;

export default function agentOrchestrator(pi: ExtensionAPI): void {
  const jobs = new JobRegistry();
  let ctx: ExtensionContext | undefined;
  let activityOpen = false;
  let children: ChildSessionRecord[] = [];
  let shells: ShellRecord[] = [];
  let shellManager!: ShellManager;
  let subagents!: SubagentManager;
  let previousEditorFactory: EditorFactory | undefined;
  let activityEditorFactory: EditorFactory | undefined;

  const refresh = () => {
    const current = ctx;
    if (!current) return;
    shells = shellManager.list();
    children = subagents.list();
    const active = jobs.list().filter((item) => item.status === 'running');
    try {
      current.ui.setStatus('agent-orchestrator', active.length ? `✱ ${active.length} running job${active.length === 1 ? '' : 's'} · ↓ Activity` : undefined);
    } catch {
      // Session replaced, reloaded, or shut down: drop the stale binding so late job events stay silent.
      ctx = undefined;
    }
  };

  const deliverCompletion = (info: import('./types.js').JobInfo) => {
    const recovery = info.recovery;
    if (!recovery || !info.notificationId) return;
    const result = info.status === 'completed' ? (info.output ?? 'Subagent completed without a text response.') : info.status === 'error' ? (info.error ?? 'Subagent failed') : 'Subagent cancelled';
    const description = recovery.kind === 'subagent' ? recovery.description : recovery.command;
    const state = info.status;
    const element = recovery.kind === 'subagent' ? `<subagent sessionID="${recovery.childSessionId}" state="${state}" description="${description}">\n${result}\n</subagent>` : result;
    try {
      pi.sendMessage({ customType: 'agent-orchestrator-completion', content: element, details: { ...info, result }, display: true }, { triggerTurn: true, deliverAs: 'followUp' });
      jobs.completeBackground(info.notificationId);
    } catch {
      // The parent session may have shut down; process-local jobs cannot outlive it.
    }
  };

  const onJobFinished = (info: import('./types.js').JobInfo) => {
    refresh();
    if (info.notificationId) deliverCompletion(info);
  };

  /**
   * Mirrors OpenCode's restart recovery (SessionRestart.resumeSuspendedSessions): deliverables left
   * pending when Pi exited are admitted once a session is active again. Live children cannot be
   * revived, so a pending subagent receipt reports the interrupted run instead of claiming success.
   */
  const recoverPendingBackground = () => {
    for (const item of jobs.pendingBackground()) {
      try {
        if (item.status !== 'running') {
          deliverCompletion({ id: item.jobId, type: item.recovery.kind, title: item.recovery.kind === 'subagent' ? item.recovery.description : item.recovery.command, status: item.status, startedAt: item.startedAt ?? Date.now(), output: item.output, error: item.error, notificationId: item.notificationId, recovery: item.recovery });
          continue;
        }
        if (item.recovery.kind === 'shell') {
          const notice = `Command cancelled because Pi restarted: ${item.recovery.command}`;
          pi.sendMessage({ customType: 'agent-orchestrator-completion', content: notice, details: { status: 'cancelled', jobId: item.jobId, result: notice }, display: true }, { triggerTurn: false, deliverAs: 'nextTurn' });
        } else {
          pi.sendMessage({ customType: 'agent-orchestrator-completion', content: `<subagent sessionID="${item.recovery.childSessionId}" state="cancelled" description="${item.recovery.description}">\nSubagent interrupted because Pi restarted.\n</subagent>`, details: { status: 'cancelled', jobId: item.jobId, result: 'Subagent interrupted because Pi restarted.' }, display: true }, { triggerTurn: false, deliverAs: 'nextTurn' });
        }
        jobs.completeBackground(item.notificationId);
      } catch {
        // The session runtime is not ready; keep the receipt for the next session start.
      }
    }
  };

  shellManager = new ShellManager(jobs, {
    changed: (record) => { shells = shellManager.list(); if (record.status !== 'running') { const info = jobs.get(record.shellID); if (info) onJobFinished(info); } refresh(); },
  });
  subagents = new SubagentManager(jobs, {
    changed: (record) => { children = subagents.list(); refresh(); },
    completed: (record) => { const info = jobs.get(record.sessionId); if (info) onJobFinished(info); },
  });

  const openActivity = async (current: ExtensionContext | ExtensionToolContext) => {
    if (activityOpen) return;
    try {
      if (!current.hasUI) return;
    } catch {
      return;
    }
    activityOpen = true;
    try {
      await current.ui.custom<void>((tui, theme, _keybindings, done) => new ActivityDocument(tui, theme, {
        shells: () => shellManager.list(),
        children: () => subagents.list(),
        cancel: (id) => { void subagents.abort(id).then(() => shellManager.cancel(id)); },
        close: done,
      }), {
        overlay: true,
        overlayOptions: { anchor: 'bottom-center', width: '100%', maxHeight: '100%', minWidth: 60, margin: { left: 0, right: 0, bottom: 0 } },
      });
    } finally {
      activityOpen = false;
      refresh();
    }
  };

  pi.on('session_start', async (_event, current) => {
    ctx = current;
    const sessionId = current.sessionManager.getSessionId();
    jobs.bindPersistence((customType, data) => {
      try {
        pi.appendEntry(customType, data);
      } catch {
        // The session was replaced while a job was still settling; recovery state cannot be written.
      }
    }, current.sessionManager.getEntries().filter((entry) => entry.type === 'custom').map((entry: any) => ({ customType: entry.customType, data: entry.data })));
    refresh();
    recoverPendingBackground();
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

  pi.on('session_shutdown', async (event) => {
    if (event.reason !== 'quit') {
      let sessionId = '';
      try {
        sessionId = ctx?.sessionManager.getSessionId() ?? '';
      } catch {
        sessionId = '';
      }
      const backgrounded = jobs.backgroundAll(sessionId);
      if (ctx && backgrounded.length) {
        const list = backgrounded.map((job) => `- ${job.type}: ${job.title || job.id}`).join('\\n');
        try {
          pi.sendMessage({ customType: 'agent-orchestrator-backgrounded', content: `Active blocking work was moved to background when this session was replaced.\\n\\nBackgrounded work:\\n${list}\\n\\nThe work is unfinished. Do not report it complete or poll; wait for its completion notification.`, display: false, details: { jobs: backgrounded } }, { deliverAs: 'nextTurn' });
        } catch {
          // Session replacement already tore down the runtime pipe.
        }
      }
      return;
    }
    ctx = undefined;
    await jobs.cancelAll();
  });

  pi.registerCommand('agents', { description: 'Open the jobs and subagents activity dock', handler: (_args, current) => openActivity(current) });

  pi.registerTool<typeof ShellParams, { output: ShellOutput; shellID: string; truncated: boolean }>({
    name: 'shell', label: 'Shell', description: 'Execute a shell command and return its output. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
    promptSnippet: 'Execute shell commands; long commands can run in the background with automatic completion notification',
    promptGuidelines: ['Use background=true for dev servers and long-running builds; no need to append &.', 'Background mode returns immediately and notifies you on completion. Do not poll for completion.', 'When output is truncated, the full result is saved to a file and a bounded preview is returned. Use shell_output for a specific output range only when needed.'],
    parameters: ShellParams,
    async execute(_id, input: ShellInput, _signal, _update, toolCtx) {
      const output = await shellManager.run(toolCtx, input, onJobFinished);
      // Mirrors OpenCode's resultMessages(): output first, then the background instruction or the
      // exit/signal/timeout notice as a separate paragraph.
      const text = shellResultText(output);
      return { content: [{ type: 'text', text }], details: { output, shellID: output.shellID, truncated: output.truncated } };
    },
    renderCall(args, theme) { return new Text(`${theme.bold('shell ')}${theme.fg('muted', args.command)}`, 0, 0); },
    renderResult(result, _options, theme) { const out = result.details?.output; return new Text(`${theme.fg(out?.status === 'completed' ? 'success' : out?.status === 'running' ? 'warning' : 'error', out?.status ?? 'error')} ${theme.fg('dim', out?.shellID ?? '')}`, 0, 0); },
  });

  pi.registerTool<typeof SubagentParams, { sessionId: string; status: string }>({
    name: 'subagent', label: 'Subagent', description: 'Spawns an agent in a child session to work on the specified task. The output includes a sessionID you can pass back later to continue that specific conversation with the subagent. New child sessions start with fresh context, so include all relevant context and instructions when you do not pass a sessionID. Foreground (default) runs the subagent to completion and returns its final response. Background mode (background=true) launches asynchronously and returns immediately; you are notified when it completes.',
    promptSnippet: 'Delegate a task to a child agent with isolated context; continue it later using its sessionID',
    promptGuidelines: ['Use background only for independent work that can run while you continue elsewhere.', 'Do not sleep, poll, or proactively check on background subagent progress; completion is delivered automatically.', 'When continuing a previous child conversation, pass its sessionID. New child sessions start with fresh context, so include the relevant context and instructions.'],
    prepareLoadout(loadout) {
      const prompt = 'The subagent type. Available agents: general (general-purpose multi-step tasks); explore (fast codebase search and read-only analysis). Specify the desired thoroughness in the prompt.';
      return { descriptions: { subagent: `Spawns an agent in a child session. ${prompt}` } };
    },
    parameters: SubagentParams,
    async execute(_id, input: SpawnSubagentInput, _signal, _update, toolCtx) {
      const result = await subagents.spawn(toolCtx, input);
      // OpenCode wraps a completed foreground subagent in a <subagent …> envelope so the calling model
      // sees the child sessionID and state; background launches stay plain text.
      const text = result.status === 'completed' ? subagentResultEnvelope(result.sessionId, result.output) : result.output;
      return { content: [{ type: 'text', text }], details: { sessionId: result.sessionId, status: result.status } };
    },
    renderCall(args, theme) { return new Text(`${theme.bold('subagent ')}${theme.fg('dim', `@${args.agent ?? 'explore'} `)}${theme.fg('muted', args.description)}`, 0, 0); },
    renderResult(result, _options, theme) { return new Text(`${theme.fg('success', result.details?.status ?? 'completed')} ${theme.fg('dim', result.details?.sessionId ?? '')}`, 0, 0); },
  });

  pi.registerTool<typeof JobStatusParams, { job?: import('./types.js').JobInfo }>({
    name: 'job_status', label: 'Job Status', description: 'Get the current status of a shell or subagent job. Use only when the user asks for status; background completion is notified automatically.', parameters: JobStatusParams,
    async execute(_id, input: JobStatusInput) { const job = jobs.get(input.id); return { content: [{ type: 'text', text: job ? JSON.stringify(job, null, 2) : `Job not found: ${input.id}` }], details: { job } }; },
  });
  pi.registerTool<typeof JobWaitParams, { job?: import('./types.js').JobInfo; timedOut: boolean }>({
    name: 'job_wait', label: 'Job Wait', description: 'Wait for a job to complete or until the optional timeout. Prefer automatic completion notifications; use only when synchronization is required.', parameters: JobWaitParams,
    async execute(_id, input: JobWaitInput) { const result = await jobs.wait(input.id, input.timeout); return { content: [{ type: 'text', text: result.info ? JSON.stringify(result.info, null, 2) : `Job not found: ${input.id}` }], details: result }; },
  });
  pi.registerTool<typeof JobBackgroundParams, { job?: import('./types.js').JobInfo }>({
    name: 'job_background', label: 'Background Job', description: 'Move an existing foreground job to background. Its parent session will receive a completion notification.', parameters: JobBackgroundParams,
    async execute(_id, input: JobBackgroundInput) { const job = jobs.background(input.id); return { content: [{ type: 'text', text: job ? JSON.stringify(job, null, 2) : `Job not found: ${input.id}` }], details: { job } }; },
  });
  pi.registerTool<typeof JobCancelParams, { job?: import('./types.js').JobInfo }>({
    name: 'job_cancel', label: 'Cancel Job', description: 'Cancel a shell or subagent job.', parameters: JobCancelParams,
    async execute(_id, input: JobCancelInput) {
      await subagents.abort(input.id);
      await shellManager.cancel(input.id);
      const job = await jobs.cancel(input.id);
      return { content: [{ type: 'text', text: job ? JSON.stringify(job, null, 2) : `Job not found: ${input.id}` }], details: { job } };
    },
  });
  pi.registerTool<typeof ShellOutputParams, { output: ShellOutput }>({
    name: 'shell_output', label: 'Shell Output', description: 'Read additional output from a shell ID returned by the shell tool. Output is offset/limit addressed; avoid repeated polling.', parameters: ShellOutputParams,
    async execute(_id, input: ShellOutputInput) { const output = await shellManager.output(input.shellID, input.offset, input.limit); return { content: [{ type: 'text', text: output.output }], details: { output } }; },
  });

  pi.registerMessageRenderer<{ status?: string; result?: string; error?: string }>('agent-orchestrator-completion', (message, _options, theme: Theme) => {
    const details = message.details;
    const color = details?.status === 'completed' ? 'success' : details?.status === 'running' ? 'warning' : 'error';
    const content = Array.isArray(message.content) ? message.content.map((part) => part.type === 'text' ? part.text : '').join('\\n') : message.content;
    return new Text(`${theme.fg(color, `● ${details?.status ?? 'completed'}`)} ${theme.fg('muted', details?.result ?? details?.error ?? content)}`, 0, 0);
  });
}
