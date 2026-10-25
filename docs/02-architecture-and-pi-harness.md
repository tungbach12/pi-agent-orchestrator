# 02 — System Architecture & Pi Harness Integration

This document explains the internal architecture of `pi-agent-orchestrator` and how it integrates natively with the `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` runtime APIs.

---

## 1. High-Level Architecture Diagram

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                         Parent Pi Session (Main Agent)                            │
│                                                                                   │
│  Tools Registered by `extensions/index.ts`:                                       │
│   • `subagent`      • `shell`         • `shell_output`                            │
│   • `job_status`    • `job_wait`      • `job_background`    • `job_cancel`        │
│                                                                                   │
│  UI & Event Integration:                                                          │
│   • `CustomEditor` (Down-arrow guard) -> `ActivityDocument` (`/agents` overlay)   │
│   • `pi.events.emit('task:subagent:lifecycle', ...)` -> Orca / Host status bar    │
│   • `pi.sendMessage({ customType: 'agent-orchestrator-completion' }, followUp)`   │
└───────────────┬───────────────────────────────────────────┬───────────────────────┘
                │                                           │
                ▼                                           ▼
┌───────────────────────────────────────┐   ┌───────────────────────────────────────┐
│           SubagentManager             │   │             ShellManager              │
│       (`extensions/subagent.ts`)      │   │         (`extensions/shell.ts`)       │
│                                       │   │                                       │
│ • `createChild()` / `resumeChild()`   │   │ • `createLocalBashOperations()`       │
│ • `resolveChildTools()` (Inherit+Excl)│   │ • Streams to `.pi/shells/<id>.log`    │
│ • `createCodemodeExtension()`         │   │ • 64 KB memory tail / 32 KB Head-Tail │
│ • `createReadOnlyGuard()` (`tool_call`)│   │ • `isServerCommand()` auto-background │
│ • `runReviewGate()` (`review.ts`)     │   │ • Positive & negative byte offsets    │
└───────────────┬───────────────────────┘   └───────────────┬───────────────────────┘
                │                                           │
                └─────────────────────┬─────────────────────┘
                                      ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                        JobRegistry (`extensions/jobs.ts`)                         │
│                                                                                   │
│ • Bounded subagent concurrency (`maxConcurrentAgents = 10`, FIFO queue)           │
│ • Unlimited shell concurrency (never blocked by queued subagents)                 │
│ • Slot retention until cancellation settles (`await job.promise`)                 │
│ • Durable recovery persistence (`pi-agent-orchestrator.recovery.v1`)              │
│ • Session-scoped pending delivery (`pendingDeliveries(parentSessionId)`)          │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Module Responsibilities

| File | Responsibility |
| :--- | :--- |
| `extensions/index.ts` | Extension entry point. Registers the 7 LLM tools, the `/agents` command, the `agent-orchestrator-completion` Markdown message renderer, session lifecycle hooks (`session_start`, `session_shutdown`), and the empty-editor `↓` key hook. |
| `extensions/types.ts` | TypeBox parameter schemas (`ShellParams`, `SubagentParams`, `Job*Params`), `AGENT_KINDS`, `BASE_CHILD_TOOLS`, `ORCHESTRATOR_EXCLUDED_TOOLS`, `AGENT_EXCLUDED_TOOLS`, and TypeScript interfaces. |
| `extensions/subagent.ts` | Manages child `AgentSession` lifecycles: creation, disk resumption via `SessionManager.open`, tool inheritance & exclusion (`resolveChildTools`), thinking & tool event tracking, one-shot empty-completion nudges, and the `review: true` verification gate. |
| `extensions/prompts.ts` | Role-specific system prompts (`EXPLORE_PROMPT`, `CODE_PROMPT`, `REVIEW_PROMPT`, `RESEARCH_PROMPT`, `REVIEWER_GATE_PROMPT`), `formatSubagentPrompt()`, `buildExecutionTelemetry()`, and `subagentResultEnvelope()`. |
| `extensions/read-only.ts` | Inline Pi `tool_call` file-modification guard (`createReadOnlyGuard`) and `.pi/plans/*.md` path validator (`isAllowedPlanPath`) for read-only child sessions. |
| `extensions/review.ts` | Independent verification gate (`runReviewGate`), command allowlist & mutation-flag detector (`verificationEvidence`), and strict `VERDICT: PASS \| NEEDS_FIX \| UNCERTAIN` parser (`parseReview`). |
| `extensions/shell.ts` | Foreground and background command runner using Pi's `createLocalBashOperations`. Streams output to `.pi/shells/<id>.log`, auto-promotes dev servers, and serves byte-range reads. |
| `extensions/shell-result.ts` | Head-tail output truncation (`truncateHeadTail`), server pattern matching (`isServerCommand`), exit/signal/timeout notices (`shellNotice`), and `<shell ...>` completion envelopes. |
| `extensions/jobs.ts` | Process-local job state machine (`queued -> running -> completed \| error \| cancelled`), concurrency queue, foreground blocking/backgrounding, and durable crash-recovery receipts. |
| `extensions/activity.ts` | Full-screen TUI overlay (`ActivityDocument`) built on `@earendil-works/pi-tui` (`Container`, `Box`, `Markdown`, `Spacer`, `Text`) matching Pi's main session visual language. |

---

## 3. Native Pi Harness Integration

`pi-agent-orchestrator` uses **only public entry points** from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, adhering to five core harness contracts:

### 3.1 Isolated Resource Loading (`DefaultResourceLoader`)
When `SubagentManager` spawns or resumes a child session, it constructs a dedicated `DefaultResourceLoader`:

```ts
const resourceLoader = new DefaultResourceLoader({
  cwd: ctx.cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  extensionFactories: [
    { name: 'orchestrator-codemode', factory: createCodemodeExtension() },
    ...(isReadOnlyAgent(agent)
      ? [{ name: 'orchestrator-read-only', factory: createReadOnlyGuard({ cwd: ctx.cwd }) }]
      : []),
  ],
  ...(systemPrompt ? { systemPrompt } : {}),
});
await resourceLoader.reload();
```

- **Why `noExtensions: true`?** The parent session already loaded user/project extensions (including `pi-agent-orchestrator`). Setting `noExtensions: true` prevents recursive extension loading, duplicate tool registrations, and status-bar hook collisions.
- **Why `createCodemodeExtension()`?** In Pi, `codemode` is a built-in extension (`builtin:codemode`) that is suppressed when `noExtensions: true` is set. Registering `createCodemodeExtension()` in `extensionFactories` restores the QuickJS `codemode` sandbox for every subagent so it can batch parallel `read`/`grep`/`find`/web calls in a single turn.

### 3.2 Inherit-All + Role Denylist Tool Resolution (`resolveChildTools`)
Instead of maintaining a brittle static allowlist that misses user-installed packages (like `pi-web-access` or MCP servers), `resolveChildTools(ctx, agent, reviewerMode)` implements an **Inherit-All + Exclude** model:

1. **Base Built-in Tools (`BASE_CHILD_TOOLS`)**:
   `['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'codemode']`
2. **Inherited Parent Tools (`inheritedParentTools`)**:
   Reads `ctx.tools` (all callable tools in the parent session, such as `web_search`, `fetch_content`, `get_search_content`, `source_check`, and `mcp__*` tools) and forwards them as `customTools` into `createAgentSession`.
3. **Orchestrator & Interactive Exclusions (`ORCHESTRATOR_EXCLUDED_TOOLS`)**:
   Always excludes `['subagent', 'shell', 'job_status', 'job_wait', 'job_background', 'job_cancel', 'shell_output', 'ask_user_question', 'powershell']` so a child session can never spawn nested subagents (`DEPTH_LIMIT = 1`) or block headless execution on an interactive dialog.
4. **Role-Specific Exclusions (`AGENT_EXCLUDED_TOOLS[agent]`)**:
   - For read-only roles (`explore`, `review`, `research`): excludes `'edit'`, `'write'`, and any parent tool whose MCP/Pi annotations mark `readOnlyHint === false` or `destructiveHint === true`.
   - Passed both as `tools: activeTools` and `excludeTools` to `createAgentSession()` so excluded tools never appear in the LLM's tool schema.

### 3.3 Provider-Compatible Tool Schema (`Type.Unsafe` Enum)
Some model providers (including Gemini and strict OpenAI-compatible gateways) flatten or drop `anyOf` unions of `Type.Literal(...)`, which previously caused `SubagentParams.properties.agent` to expose only the first literal (`"explore"`). `SubagentParams` uses a flat string `enum` schema:

```ts
agent: Type.Unsafe<AgentKind>({
  type: 'string',
  enum: [...AGENT_KINDS], // ['explore', 'code', 'review', 'research', 'general']
})
```

This guarantees all 5 subagent roles are visible in the tool declaration across every provider.

### 3.4 Durable Session Linkage (`SessionManager`)
Every child session is created via:

```ts
SessionManager.create(ctx.cwd, undefined, { parentSession: parentSessionFile })
```

and tagged with a custom entry (`pi-agent-orchestrator.child`) storing `{ agent, description, model }`. Because the child is a standard Pi `.jsonl` session file on disk:
- Passing `sessionID` in a subsequent `subagent` call reopens the session via `SessionManager.open(info.path, undefined, cwd)` — even across Pi restarts.
- `resumeChild()` verifies `info.parentSessionPath === parentFile` and `saved.agent === input.agent`, preventing cross-session hijacking or role confusion.

### 3.5 Model & Thinking Inheritance
Child sessions inherit both `ctx.model` (unless overridden via `input.model`) and `ctx.thinkingLevel ?? 'medium'` directly from the parent session, keeping reasoning depth predictable and under the user's control in the main TUI.
