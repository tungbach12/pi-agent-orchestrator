import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Spacer, matchesKey, Text, type EditorComponent, type TUI } from '@earendil-works/pi-tui';
import { ActivityDocument, buildMarkdownTheme, shouldInstallEditorHook, shouldOpenActivityFromEditorInput } from './activity.js';
import { JobRegistry } from './jobs.js';
import { ShellManager } from './shell.js';
import { SubagentManager, type ChildSessionRecord } from './subagent.js';
import { shellCompletionEnvelope, shellResultText } from './shell-result.js';
import { subagentResultEnvelope, truncateSubagentOutput } from './prompts.js';
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

interface OrchestratorProcessRuntime {
  jobs: JobRegistry;
  shellManager: ShellManager;
  subagents: SubagentManager;
}

declare global {
  var __piAgentOrchestratorRuntime: OrchestratorProcessRuntime | undefined;
}

/**
 * Adds background jobs and child agents to Pi.
 *
 * A command or a child agent becomes a job. Foreground jobs block the call and
 * return their result; background jobs return a receipt and report their
 * completion to the parent session on its own, so the model never has to poll.
 */
export default function agentOrchestrator(pi: ExtensionAPI): void {
  // Reuse the live runtime across in-process `/reload` in Pi while keeping unit
  // test harnesses (which omit `pi.events`) isolated per test.
  const useProcessSingleton = Boolean((pi as { events?: unknown }).events);
  const existingRuntime = useProcessSingleton ? globalThis.__piAgentOrchestratorRuntime : undefined;
  const jobs = existingRuntime?.jobs ?? new JobRegistry();
  let ctx: ExtensionContext | undefined;
  let activityOpen = false;
  let shuttingDown = false;
  const shellEvents = {
    changed: () => refresh(),
    started: () => refresh(),
    settled: (info: import('./types.js').JobInfo) => {
      refresh();
      // A backgrounded command reports itself; a foreground one already
      // returned its result to the model.
      if (info.notificationId) deliver(info);
    },
  };
  const shellManager = existingRuntime?.shellManager ?? new ShellManager(jobs, shellEvents);
  shellManager.setEvents(shellEvents);

  const emitSubagentLifecycle = (
    record: ChildSessionRecord,
    status: 'started' | 'completed' | 'failed' | 'aborted',
  ) => {
    try {
      pi.events?.emit('task:subagent:lifecycle', {
        id: record.sessionId,
        agent: record.agent,
        description: record.description,
        status,
      });
    } catch {
      // Optional host event bus may not be attached in minimal test harnesses.
    }
  };

  const subagentEvents = {
    changed: () => refresh(),
    started: (record: ChildSessionRecord) => {
      refresh();
      emitSubagentLifecycle(record, 'started');
    },
    completed: (record: ChildSessionRecord, info: import('./types.js').JobInfo) => {
      refresh();
      const lifecycleStatus =
        info.status === 'completed' ? 'completed' : info.status === 'cancelled' ? 'aborted' : 'failed';
      emitSubagentLifecycle(record, lifecycleStatus);
      // A backgrounded child reports itself; a foreground one already returned
      // its result to the model.
      if (info.notificationId) deliver(info);
    },
  };
  const subagents = existingRuntime?.subagents ?? new SubagentManager(jobs, subagentEvents);
  subagents.setEvents(subagentEvents);
  if (useProcessSingleton) {
    globalThis.__piAgentOrchestratorRuntime = { jobs, shellManager, subagents };
  }
  let previousEditorFactory: EditorFactory | undefined;
  let activityEditorFactory: EditorFactory | undefined;
  let lastStatusText: string | undefined;

  function refresh(force = false): void {
    const current = ctx;
    if (!current) return;
    const active = jobs.list().filter((item) => item.status === 'running' || item.status === 'queued');
    const nextStatus = active.length
      ? `✱ ${active.length} running job${active.length === 1 ? '' : 's'} · ↓ Activity`
      : undefined;
    if (!force && nextStatus === lastStatusText) return;
    lastStatusText = nextStatus;
    try {
      current.ui.setStatus('agent-orchestrator', nextStatus);
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
    if (shuttingDown) return;
    const recovery = info.recovery;
    if (!recovery || !info.notificationId) return;
    // Prevent cross-session turn pollution when the user switched sessions in-process.
    // The receipt stays in JobRegistry and is delivered when the originating session resumes.
    const activeSessionId = ctx?.sessionManager.getSessionId();
    if (activeSessionId && recovery.parentSessionId && activeSessionId !== recovery.parentSessionId) {
      return;
    }
    const shellRecord = recovery.kind === 'shell' ? shellManager.get(recovery.shellId) : undefined;
    const childRecord = recovery.kind === 'subagent' ? subagents.get(recovery.childSessionId) : undefined;
    const result =
      info.status === 'completed'
        ? (info.output ?? 'Subagent completed without a text response.')
        : info.status === 'error'
          ? (info.error ?? 'Subagent failed')
          : recovery.kind === 'subagent'
            ? (childRecord?.result?.trim()
                ? `${childRecord.result.trim()}\n\n[Subagent was stopped before completion. Full conversation and tool history are preserved in sessionID="${recovery.childSessionId}". Resume it by calling subagent with agent="${recovery.agent}" and sessionID="${recovery.childSessionId}".]`
                : `Subagent was stopped before completion. Its conversation and completed tool calls are preserved in sessionID="${recovery.childSessionId}". Resume it by calling subagent with agent="${recovery.agent}" and sessionID="${recovery.childSessionId}".`)
            : 'Cancelled';
    const label = recovery.kind === 'subagent' ? recovery.description : recovery.command;
    const content =
      recovery.kind === 'subagent'
        ? subagentResultEnvelope(recovery.childSessionId, result, {
            state: info.status,
            agent: recovery.agent,
            description: label,
            tools: childRecord?.tools,
          })
        : shellCompletionEnvelope({
            shellID: recovery.shellId,
            state: info.status,
            command: recovery.command,
            output: result,
            exit: shellRecord?.exitCode,
            file: shellRecord?.file,
          });
    try {
      const wasCancelled = info.status === 'cancelled';
      pi.sendMessage(
        {
          customType: 'agent-orchestrator-completion',
          content,
          details: { ...info, result },
          display: true,
        },
        wasCancelled
          ? { triggerTurn: false, deliverAs: 'nextTurn' }
          : { triggerTurn: true, deliverAs: 'steer' },
      );
      jobs.completeBackground(info.notificationId);
    } catch {
      // Keep the recovery receipt; the next session will deliver it.
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
      const activeSessionId = current.sessionManager.getSessionId();
      await current.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new ActivityDocument(tui, theme, {
            shells: () => shellManager.list(activeSessionId),
            children: () => subagents.list(activeSessionId),
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
      refresh(true);
    }
  };

  pi.on('session_start', async (_event, current) => {
    ctx = current;
    lastStatusText = undefined;
    const appendEntry = (customType: string, data: unknown) => {
      try {
        pi.appendEntry(customType, data);
      } catch {
        // The session was replaced while a job was still settling.
      }
    };
    const customEntries = current.sessionManager
      .getEntries()
      .filter((entry) => entry.type === 'custom')
      .map((entry: any) => ({ customType: entry.customType, data: entry.data }));
    const activeSessionId = current.sessionManager.getSessionId();

    jobs.bindPersistence(appendEntry, customEntries);
    shellManager.bindPersistence(appendEntry, customEntries, activeSessionId, current.cwd);
    subagents.bindPersistence(appendEntry, customEntries, activeSessionId);
    await subagents.syncParentSession(current);
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
          if (
            matchesKey(data, 'escape') &&
            !tui.hasOverlay() &&
            !(editor as { isShowingAutocomplete?(): boolean }).isShowingAutocomplete?.() &&
            subagents.hasActiveForParent(current.sessionManager.getSessionId())
          ) {
            const idle = current.isIdle();
            void subagents.abortAllForParent(current.sessionManager.getSessionId());
            if (idle) return;
          }
          originalHandleInput(data);
        };
        return editor;
      };
      current.ui.setEditorComponent(activityEditorFactory);
    }
  });

  pi.on('agent_settled', (event, current) => {
    if (event.aborted) {
      void subagents.abortAllForParent(current.sessionManager.getSessionId());
    }
  });

  pi.on('input', (event, current) => {
    if (event.source !== 'interactive' || !event.streamingBehavior) return undefined;
    const text = event.text.trim();
    if (!text || text.startsWith('/') || text.startsWith('!')) return undefined;
    const activeSessionId = current.sessionManager.getSessionId();
    // Move any foreground-blocking work (subagent, shell, or active job_wait) to
    // the background immediately when the user sends a message during streaming,
    // so the Main Agent can respond right away without aborting in-flight work.
    jobs.backgroundAll(activeSessionId);
    return undefined;
  });

  pi.on('before_agent_start', (_event, current) => {
    const activeSessionId = current.sessionManager.getSessionId();
    const interrupted = subagents.consumeInterruptedForParent(activeSessionId);
    if (interrupted.length === 0) return undefined;
    const lines = interrupted.map(
      (child) =>
        `- sessionID="${child.sessionId}" agent="${child.agent}" description=${JSON.stringify(child.description)}`,
    );
    return {
      message: {
        customType: 'agent-orchestrator-interrupted-subagents',
        content: `<interrupted_subagents>\nThe following subagent(s) were stopped before completion and have their conversation and tool history preserved:\n${lines.join('\n')}\n\nIf the user is asking to continue (e.g. "continue", "tiếp tục", "chạy tiếp") or you still need their findings/work, resume each stopped subagent by calling \`subagent\` with its exact \`sessionID\` and \`agent\` (for example: \`prompt: "Continue from where you left off and complete the required output."\`). Do not redo their work from scratch in the parent session.\n</interrupted_subagents>`,
        display: false,
      },
    };
  });

  /**
   * Reports jobs that were still running when Pi last stopped.
   *
   * A live process cannot survive a restart, so the receipt says the work was
   * interrupted instead of pretending it finished.
   */
  function recoverPending(): void {
    const activeSessionId = ctx?.sessionManager.getSessionId();
    for (const item of jobs.pendingDeliveries(activeSessionId)) {
      const interrupted = item.status === 'running' || item.status === 'queued' ||
        (item.status === 'cancelled' && item.error?.startsWith('Interrupted because Pi shut down') === true);
      const result = interrupted
        ? item.status === 'queued'
          ? 'Interrupted because Pi restarted before this queued job could start.'
          : 'Interrupted because Pi restarted before this job completed.'
        : item.status === 'cancelled'
          ? 'Cancelled before Pi restarted.'
          : item.error ?? item.output ?? 'Job finished before Pi restarted.';
      const recovered: import('./types.js').JobInfo = {
        id: item.jobId,
        type: item.recovery.kind,
        title: item.recovery.kind === 'subagent' ? item.recovery.description : item.recovery.command,
        status: interrupted ? 'cancelled' : item.status,
        startedAt: item.startedAt ?? Date.now(),
        completedAt: Date.now(),
        output: item.output,
        error: interrupted ? result : item.error,
        notificationId: item.notificationId,
        recovery: item.recovery,
      };
      const content = item.recovery.kind === 'subagent'
        ? `<subagent sessionID="${item.recovery.childSessionId}" state="${recovered.status}" agent="${item.recovery.agent}" description="${item.recovery.description}">\n${truncateSubagentOutput(result)}\n</subagent>`
        : shellCompletionEnvelope({
            shellID: item.recovery.shellId,
            state: recovered.status,
            command: item.recovery.command,
            output: result,
          });
      try {
        pi.sendMessage(
          {
            customType: 'agent-orchestrator-completion',
            content,
            details: { ...recovered, result },
            display: true,
          },
          { triggerTurn: false, deliverAs: 'nextTurn' },
        );
        jobs.completeBackground(item.notificationId, recovered);
      } catch {
        // Leave the persisted receipt to retry on the next session start.
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
          await pi.sendMessage(
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
    shuttingDown = true;
    ctx = undefined;
    // Pi/process shutdown stops in-process jobs. Mark them interrupted in
    // durable recovery state rather than reporting an ordinary user cancel.
    await jobs.cancelAll('Interrupted because Pi shut down before the job completed.');
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
      'Use background=true for dev servers and long-running builds; common dev servers and watch commands are also auto-backgrounded after startup.',
      'Background commands report their completion on their own. Do not poll for it.',
      'Use shell_output with offset/limit (or negative offset to read the tail) when inspecting truncated command logs.',
    ],
    parameters: ShellParams,
    async execute(_id, input: ShellInput, signal, _update, toolCtx) {
      const output = await shellManager.run(toolCtx, input, signal);
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
        out?.status === 'completed'
          ? 'success'
          : out?.status === 'running' || out?.status === 'queued'
            ? 'warning'
            : 'error';
      return new Text(`${theme.fg(color, out?.status ?? 'error')} ${theme.fg('dim', out?.shellID ?? '')}`, 0, 0);
    },
  });

  pi.registerTool<typeof SubagentParams, { sessionId: string; status: string; output?: string }>({
    name: 'subagent',
    label: 'Subagent',
    description:
      'Delegate a task to a child agent with its own context ("explore", "code", "review", "research", or "general"). The result includes a sessionID that continues the same conversation later. Foreground (default) runs the child to completion; background=true launches it and returns immediately. For "code" or "general" code changes, review=true requests an independent read-only review against the task, with at most one fix/re-review round; this costs an extra agent run and does not replace tests.',
    promptSnippet: 'Delegate a task to a child agent with isolated context; continue it later using its sessionID',
    promptGuidelines: [
      'Use direct tools (read, grep, find, edit) for single-file lookups or quick edits; delegate to subagent when broad exploration, deep research, isolated coding, or independent review is needed.',
      'When spawning multiple subagents for independent subtasks, issue all subagent calls in the same response so they run concurrently.',
      'New child sessions start with fresh context: provide a self-contained prompt with the objective, relevant file paths/symbols, and scope boundaries (including what NOT to touch), and set expectedOutput to specify the exact questions, sections, file:line citations, or verification outputs required.',
      'When a subagent completes, inspect the <telemetry> block inside <subagent> (tool calls, files modified, commands executed, verification status) to verify ground-truth execution rather than relying on prose claims alone. If any required item is missing or unverified, resume the same child session by passing its sessionID.',
      'If a subagent was stopped before completion (state="cancelled") and the user asks to continue (e.g., "continue", "tiếp tục", "chạy tiếp") or you still need its output, resume that exact subagent by passing its sessionID and agent rather than redoing its work from scratch in the parent session.',
      'To steer or inject new instructions into an already-running subagent without losing its progress, call subagent with its sessionID, agent, description, and the new prompt (set background=true to keep it in the background, or omit background to wait for its completion). To stop a running subagent, call job_cancel({ id: sessionID }).',
      'Use background=true only for work that can run while you continue elsewhere. Do not sleep or poll a background subagent; completion is delivered automatically.',
    ],
    prepareLoadout() {
      const prompt =
        'The subagent type. Available agents: explore (fast read-only codebase search); code (focused implementation & verification with the coding tool set); review (read-only code/diff reviewer); research (read-only deep researcher across web, GitHub & local code); general (multi-step work with the full tool set). Set review=true only for significant code or general tasks that need independent plan/criteria review; it adds latency and tokens.';
      return { descriptions: { subagent: `Spawns an agent in a child session. ${prompt}` } };
    },
    parameters: SubagentParams,
    async execute(_id, input: SubagentInput, signal, _update, toolCtx) {
      const result = await subagents.spawn(toolCtx, input, signal);
      const text =
        result.status === 'completed' || result.status === 'cancelled'
          ? subagentResultEnvelope(result.sessionId, result.output, {
              state: result.status,
              agent: input.agent,
              description: input.description,
              tools: result.tools,
            })
          : result.output;
      return {
        content: [{ type: 'text', text }],
        details: { sessionId: result.sessionId, status: result.status, output: result.output },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('subagent'))} ${theme.fg('accent', `@${args.agent ?? 'explore'}`)} ${theme.fg('toolOutput', args.description ?? '')}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      const isError = Boolean(context?.isError);
      const status = result.details?.status ?? (isError ? 'error' : 'completed');
      const icon = status === 'completed' ? '✓' : status === 'running' ? '●' : '✗';
      const color = status === 'completed' ? 'success' : status === 'running' ? 'warning' : 'error';
      const fallbackText = Array.isArray(result.content)
        ? result.content
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
        : '';
      const out = (result.details?.output ?? fallbackText).trim();
      const hint = !options.expanded && out && status === 'completed' ? theme.fg('dim', ' (click/ctrl+o to expand)') : '';
      const sessionIdPart = result.details?.sessionId ? ` ${theme.fg('dim', result.details.sessionId)}` : '';
      const header = new Text(
        `${theme.fg(color, `${icon} ${status}`)}${sessionIdPart}${hint}`,
        0,
        0,
      );
      if (isError && out && !options.expanded) {
        const container = new Container();
        container.addChild(header);
        container.addChild(new Text(theme.fg('error', out.split('\n')[0] ?? out), 0, 0));
        return container;
      }
      if (!options.expanded || !out) return header;
      const container = new Container();
      container.addChild(header);
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(out, 0, 0, buildMarkdownTheme(theme)));
      return container;
    },
  });

  function renderJobCallLabel(toolName: string, idOrTitle: string | undefined, theme: Theme): Text {
    const raw = idOrTitle ?? '';
    const resolvedId = raw ? jobs.resolveId(raw) : '';
    const child = (resolvedId ? subagents.get(resolvedId) : undefined) ?? (raw ? subagents.get(raw) : undefined);
    const job = resolvedId ? jobs.get(resolvedId) : undefined;
    const shell = resolvedId ? shellManager.get(resolvedId) : undefined;

    if (child || job?.recovery?.kind === 'subagent' || job?.type === 'subagent') {
      const agent = child?.agent ?? (job?.recovery?.kind === 'subagent' ? job.recovery.agent : undefined);
      const title =
        child?.description ??
        job?.title ??
        (job?.recovery?.kind === 'subagent' ? job.recovery.description : undefined) ??
        raw;
      const agentPart = agent ? `${theme.fg('accent', `@${agent}`)} ` : '';
      return new Text(
        `${theme.fg('toolTitle', theme.bold(toolName))} ${agentPart}${theme.fg('toolOutput', title)}`,
        0,
        0,
      );
    }

    if (shell || job?.type === 'shell') {
      const command = shell?.command ?? job?.title ?? raw;
      return new Text(
        `${theme.fg('toolTitle', theme.bold(toolName))} ${theme.fg('accent', 'shell')} ${theme.fg('toolOutput', command)}`,
        0,
        0,
      );
    }

    return new Text(`${theme.fg('toolTitle', theme.bold(toolName))} ${theme.fg('toolOutput', raw)}`, 0, 0);
  }

  function renderJobStatusResult(
    info: import('./types.js').JobInfo | undefined,
    options: { expanded: boolean },
    theme: Theme,
    extra?: { timedOut?: boolean; backgrounded?: boolean; isError?: boolean },
  ) {
    if (!info) {
      return new Text(theme.fg('error', '✗ job not found'), 0, 0);
    }
    const status = info.status ?? (extra?.isError ? 'error' : 'completed');
    const icon = status === 'completed' ? '✓' : status === 'running' || status === 'queued' ? '●' : '✗';
    const color =
      status === 'completed'
        ? 'success'
        : status === 'running' || status === 'queued'
          ? 'warning'
          : 'error';
    const suffix = extra?.backgrounded
      ? ' (paused wait)'
      : extra?.timedOut && (status === 'running' || status === 'queued')
        ? ' (timed out, still running)'
        : '';
    const out = (info.output ?? info.error ?? '').trim();
    const hint =
      !options.expanded && out && status === 'completed' ? theme.fg('dim', ' (click/ctrl+o to expand)') : '';
    const header = new Text(`${theme.fg(color, `${icon} ${status}${suffix}`)}${hint}`, 0, 0);
    if (!options.expanded || !out) return header;
    const container = new Container();
    container.addChild(header);
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(out, 0, 0, buildMarkdownTheme(theme)));
    return container;
  }

  pi.registerTool<typeof JobStatusParams, { job?: import('./types.js').JobInfo }>({
    name: 'job_status',
    label: 'Job Status',
    description:
      'Get the current status of a shell or subagent job (queued, running, completed, error, or cancelled). Accepts the job/shell ID or subagent description/title. Use it only when the user asks for status; a background job reports its completion on its own.',
    parameters: JobStatusParams,
    async execute(_id, input: JobStatusInput) {
      const job = jobs.get(input.id);
      if (job && job.status !== 'running' && job.status !== 'queued') {
        jobs.suppressNotification(job.id);
        if (job.notificationId) jobs.completeBackground(job.notificationId);
      }
      return {
        content: [
          { type: 'text', text: job ? JSON.stringify(job, null, 2) : `Job not found: ${input.id}` },
        ],
        details: { job },
      };
    },
    renderCall(args, theme) {
      return renderJobCallLabel('job_status', args.id, theme);
    },
    renderResult(result, options, theme, context) {
      return renderJobStatusResult(result.details?.job, options, theme, {
        isError: Boolean(context?.isError),
      });
    },
  });

  pi.registerTool<
    typeof JobWaitParams,
    { info?: import('./types.js').JobInfo; timedOut: boolean; backgrounded?: boolean; aborted?: boolean }
  >({
    name: 'job_wait',
    label: 'Job Wait',
    description:
      'Wait for a queued or running job to finish, or until the optional timeout. Accepts the job/shell ID or subagent description/title. Prefer the automatic completion notice; use this only when you need the result right now.',
    parameters: JobWaitParams,
    async execute(_id, input: JobWaitInput, signal, _update, toolCtx) {
      const result = await jobs.wait(input.id, input.timeout, {
        sessionId: toolCtx.sessionManager.getSessionId(),
        signal,
      });
      if (!result.timedOut && result.info) {
        jobs.suppressNotification(result.info.id);
        if (result.info.notificationId) {
          jobs.completeBackground(result.info.notificationId);
        }
      }
      const payload =
        result.backgrounded && result.info
          ? {
              ...result.info,
              timedOut: true,
              waitInterrupted:
                'Stopped waiting because the user sent a message. The job is still running in the background and will report completion automatically; respond to the user first instead of calling job_wait again.',
            }
          : result.info;
      return {
        content: [
          {
            type: 'text',
            text: payload ? JSON.stringify(payload, null, 2) : `Job not found: ${input.id}`,
          },
        ],
        details: result,
      };
    },
    renderCall(args, theme) {
      return renderJobCallLabel('job_wait', args.id, theme);
    },
    renderResult(result, options, theme, context) {
      return renderJobStatusResult(result.details?.info, options, theme, {
        timedOut: result.details?.timedOut,
        backgrounded: result.details?.backgrounded,
        isError: Boolean(context?.isError),
      });
    },
  });

  pi.registerTool<typeof JobBackgroundParams, { job?: import('./types.js').JobInfo }>({
    name: 'job_background',
    label: 'Background Job',
    description:
      'Move a running foreground job to the background. Accepts the job/shell ID or subagent description/title. The parent session is notified when it finishes.',
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
    renderCall(args, theme) {
      return renderJobCallLabel('job_background', args.id, theme);
    },
    renderResult(result, options, theme, context) {
      return renderJobStatusResult(result.details?.job, options, theme, {
        isError: Boolean(context?.isError),
      });
    },
  });

  pi.registerTool<typeof JobCancelParams, { job?: import('./types.js').JobInfo }>({
    name: 'job_cancel',
    label: 'Cancel Job',
    description: 'Cancel a running shell or subagent job. Accepts the job/shell ID or subagent description/title.',
    parameters: JobCancelParams,
    async execute(_id, input: JobCancelInput) {
      const resolvedId = jobs.resolveId(input.id);
      jobs.suppressNotification(resolvedId);
      await subagents.abort(resolvedId);
      await shellManager.cancel(resolvedId);
      const job = await jobs.cancel(resolvedId);
      return {
        content: [
          { type: 'text', text: job ? JSON.stringify(job, null, 2) : `Job not found: ${input.id}` },
        ],
        details: { job },
      };
    },
    renderCall(args, theme) {
      return renderJobCallLabel('job_cancel', args.id, theme);
    },
    renderResult(result, options, theme, context) {
      return renderJobStatusResult(result.details?.job, options, theme, {
        isError: Boolean(context?.isError),
      });
    },
  });

  pi.registerTool<typeof ShellOutputParams, { output: ShellOutput }>({
    name: 'shell_output',
    label: 'Shell Output',
    description:
      'Read a bounded range of a shell command output. The offset and limit are in bytes; avoid reading the same range repeatedly.',
    parameters: ShellOutputParams,
    async execute(_id, input: ShellOutputInput) {
      const resolvedId = jobs.resolveId(input.shellID);
      const output = await shellManager.output(resolvedId, input.offset, input.limit);
      const isFinished = output.status !== 'running' && output.status !== 'queued';
      if (isFinished) {
        jobs.suppressNotification(resolvedId);
      }
      const includeStatusFooter = isFinished && (input.limit === undefined || input.limit >= 256);
      const statusFooter = includeStatusFooter
        ? `\n[Process ${output.status}${output.exit !== undefined ? ` (exit code ${output.exit})` : ''}]`
        : '';
      return { content: [{ type: 'text', text: `${output.output}${statusFooter}` }], details: { output } };
    },
    renderCall(args, theme) {
      return renderJobCallLabel('shell_output', args.shellID, theme);
    },
  });

  pi.registerMessageRenderer<{ status?: string; title?: string; result?: string; error?: string }>(
    'agent-orchestrator-completion',
    (message, options, theme: Theme) => {
      const details = message.details;
      const color =
        details?.status === 'completed'
          ? 'success'
          : details?.status === 'running' || details?.status === 'queued'
            ? 'warning'
            : 'error';
      const content = Array.isArray(message.content)
        ? message.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('\n')
        : message.content;
      const bodyText = (details?.result ?? details?.error ?? content ?? '').trim();
      const title = details?.title ? ` ${theme.fg('dim', details.title)}` : '';
      const hint = !options.expanded && bodyText.includes('\n') ? theme.fg('dim', ' (click/ctrl+o to expand)') : '';
      const header = new Text(`${theme.fg(color, `● ${details?.status ?? 'completed'}`)}${title}${hint}`, 0, 0);
      if (!bodyText) return header;
      if (!options.expanded && bodyText.split('\n').length > 8) {
        const preview = bodyText.split('\n').slice(0, 6).join('\n');
        const container = new Container();
        container.addChild(header);
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(preview, 0, 0, buildMarkdownTheme(theme)));
        return container;
      }
      const container = new Container();
      container.addChild(header);
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(bodyText, 0, 0, buildMarkdownTheme(theme)));
      return container;
    },
  );
}
