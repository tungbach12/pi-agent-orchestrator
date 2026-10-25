# pi-agent-orchestrator

Background shell jobs and child agents for [Pi](https://github.com/earendil-works/pi), with automatic
completion notifications and a dock that shows what is running.

## Why

Pi runs one agent loop at a time. Long builds, test suites, dev servers, and independent
investigations all compete for that single loop, and a blocking command stalls everything else.

This package adds a small orchestration layer on top of Pi:

- work that can run in parallel, does
- background work reports back on its own instead of being polled
- delegated work keeps its own context, so the parent stays small
- everything running is visible in one place

## Features

**Shell execution**
Runs commands in the foreground by default, or hands them to the background and returns immediately.
Foreground commands default to a 120-second timeout; background commands have none. Common dev
servers and watch commands (`npm run dev`, `vite`, `next dev`, `uvicorn`, `tsc --watch`, etc.) are
automatically promoted to the background after a short startup window so they never block the
foreground loop until timeout. Output streams to a log file under `.pi/shells/` as it arrives, and
inline results use head-tail truncation (preserving both startup output and the final summary/error
lines) so a noisy build cannot flood the context window. `shell_output` supports both positive byte
offsets and negative offsets (to tail the end of a log file). Exit code, signal, and timeout are
reported as distinct outcomes rather than collapsed into "failed".

**Child agents**
Delegates a task to an agent with its own context. Every child session inherits Pi's built-in tools
(including `codemode` via `createCodemodeExtension()`) plus callable tools from the parent session
(`ctx.tools`, such as `web_search`, `fetch_content`, MCP tools, etc.), and then applies a role-specific
exclusion list (`AGENT_EXCLUDED_TOOLS` / `excludeTools`) so orchestrator/interactive tools (`subagent`,
`shell`, `job_*`, `ask_user_question`) are never exposed to children and write/destructive tools are
excluded from read-only roles. Five roles are available:

- `explore` — fast codebase search specialist. Excludes `edit` and `write`, and guards `bash` to
  read-only commands.
- `code` — focused implementation and verification specialist with the full coding tool set (`read`,
  `grep`, `find`, `ls`, `bash`, `edit`, `write`, `codemode`, plus inherited parent tools).
- `review` — standalone read-only code and diff reviewer. Audits repository state, diffs, and test
  coverage, reporting concrete findings with `file:line` evidence and severity.
- `research` — read-only deep researcher. Investigates external docs, libraries, and GitHub
  repositories (via read-only `gh` CLI commands and inherited web/MCP tools) alongside local
  codebase context.
- `general` — multi-step work with the full coding tool set (`read`, `grep`, `find`, `ls`, `bash`,
  `edit`, `write`, `codemode`, plus inherited parent tools) using Pi's default system prompt.

Child conversations are real Pi session files linked to their parent, so passing the returned
`sessionID` resumes the same conversation — including after restarting Pi. For significant `code` or
`general` coding tasks, set `review: true` to request an independent read-only review of the task
criteria, repository changes, and observed verification commands. A concrete review finding allows
one focused fix and one re-review at most. Review is opt-in, costs an extra agent run, and fails
closed: missing or failed recognized verification evidence, an uncertain review, or unresolved
findings do not return an approved result. It does not replace running the project's required checks.

**Read-only guard**
Read-only agents (`explore`, `review`, `research`) exclude `edit` and `write` from their tool schema
and install `createReadOnlyGuard()` on Pi's `tool_call` hook so any direct `write` or `edit` call is
blocked before it runs, while `bash` remains unrestricted for repository inspection (`git -C ...`,
`find`, `rg`, pipelines, etc.) under the child's read-only system prompt. The guard applies to the
child session only; the parent session keeps its full tool set.

**Bounded queue and delivery recovery**
Up to four jobs execute at once by default; additional work is shown as `Queued`. Cancelling a queued
job prevents it from starting. Cancelling a running job asks Pi's shell or child session to stop and
waits for the operation to settle before reusing its slot. Completion receipts remain in session
state until `sendMessage` accepts them. On process shutdown, unfinished jobs are persisted as
interrupted and reported in the next session; session switches within the same Pi process preserve
live background jobs.

**Job lifecycle**
Every command and child agent becomes a job that can be inspected, waited on, moved to the
background, or cancelled. Interrupted work leaves a receipt instead of vanishing silently.

**Completion notifications**
Background work wakes the parent session when it finishes. Polling is unnecessary, and the tool
descriptions and receipts say so explicitly.

**Activity dock**
A compact `Subagents` / `Shell` view, plus a full-screen detail with expandable Thought and Explored
groups, tool history, mouse-wheel scrolling, and interruption. The dock uses the active Pi theme, so
it follows the terminal's colors.

## Usage

Press `↓` with an empty editor — and no active overlay, autocomplete, or history browsing — to open
the dock, or run `/agents`.

| Key | Action |
|---|---|
| `↑` / `↓` | Move the selection |
| `←` / `→` | Switch between Subagents and Shell |
| `Enter` | Open the detail view |
| `Esc` | Close the dock, or return from detail |

Arrow keys stay with Pi whenever you are typing, browsing history or autocomplete, or using a
selector, so nothing is taken away from normal editing.

In the detail view, `Esc` or `←` returns to the list, the mouse wheel scrolls, and Thought/Explored
groups toggle on click.

### Tools

| Tool | Purpose |
|---|---|
| `shell` | Run a command, foreground or background |
| `subagent` | Delegate to `explore`, `code`, `review`, `research`, or `general`; continue with `sessionID` |
| `job_status` | Inspect a job |
| `job_wait` | Block until a job finishes, with an optional timeout |
| `job_background` | Move a foreground job to the background |
| `job_cancel` | Cancel a job |
| `shell_output` | Read a bounded range of a shell's output |

## Defaults

- Foreground `shell` timeout: **120,000 ms**. Background runs: no timeout unless one is passed.
- At most **10** child subagents execute at once by default. Additional subagents are queued and
  shown as `Queued`; cancelling a queued subagent removes it before it starts.
- Shell commands (foreground and background) have **no concurrency limit** and run without queueing.
- Cancelling a running subagent or command waits until the underlying session or process has actually
  stopped before its execution slot is reused.
- Subagent nesting depth: **1**. A child session does not load extensions, so it cannot spawn
  another child.
- A background launch returns a receipt with its ID and an instruction not to poll.
- `general` uses Pi's own system prompt; it is not overridden.

## Design notes

**Native Pi APIs only.** The package uses Pi's own `createAgentSession`, `SessionManager`,
`DefaultResourceLoader`, `createLocalBashOperations`, and `Theme`. Child sessions are created with
`noExtensions: true` so the orchestrator is not loaded twice, and they get Pi's own tool names
(`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`). The read-only guard is an inline extension
that uses Pi's `tool_call` hook.

**Durable children, process-local jobs.** Child sessions are real session files linked to their
parent, so they survive a restart. Running OS processes and live agent runtimes do not: they belong
to the Pi process that started them. On shutdown, unfinished jobs are persisted as interrupted receipts and reported on the next
session start rather than pretending they finished. A receipt is removed only after Pi accepts the
completion message. Session switches within the same Pi process preserve running background jobs
and their completion receipts.

**Completion over polling.** Every background path delivers a message back to the parent session.
The tool descriptions, receipts, and recovery notices all say the same thing, because polling
wastes turns and tokens.

**Arrows belong to the editor.** The dock never takes a global key. It opens only from an empty
editor, and the guard is checked at input time so overlays, autocomplete, history browsing, and
selectors keep working normally.

## Documentation

Detailed technical documentation, empirical benchmarks, architecture diagrams, and failure-mode analyses are available in [`docs/`](./docs):

1. [**01 — Problem Statement, Failure Taxonomy & Empirical Research**](./docs/01-problem-and-research.md): Quantitative findings from MAST (NeurIPS 2025, 1,600+ traces), Anthropic Multi-Agent Research (+90.2% gain, BrowseComp 80% token-variance analysis), OpenDev (arXiv:2603.05344), Task Spec Contracts (31% $\to$ 7% scope-error reduction), and production post-mortems.
2. [**02 — System Architecture & Pi Harness Integration**](./docs/02-architecture-and-pi-harness.md): Component diagrams, `DefaultResourceLoader` isolation, `createCodemodeExtension()` integration, Inherit-All + Role Denylist tool resolution (`resolveChildTools`), and durable `SessionManager` linkage.
3. [**03 — Subagent Roles, Handoff Protocol & Verification Gate**](./docs/03-subagent-roles-and-handoff-protocol.md): Capability matrix for `explore`, `research`, `code`, `review`, and `general`; the 4-stage reliable handoff protocol (`expectedOutput`, `EMPTY_COMPLETION_NUDGE`, `<telemetry>` receipts, `sessionID` continuation); `createReadOnlyGuard()`; and the fail-closed `review: true` gate.
4. [**04 — Background Jobs, Shell Pipeline & Crash Recovery**](./docs/04-background-jobs-and-shell-engine.md): `JobRegistry` state machine, 32 KB Head-Tail truncation, automatic dev-server promotion (`isServerCommand`), negative-offset tail reads, and session-scoped durable recovery (`pi-agent-orchestrator.recovery.v1`).
5. [**05 — TUI Activity Dock & The 4-Phase Engineering Workflow**](./docs/05-tui-activity-dock-and-workflows.md): Main-session-matched TUI rendering (`Markdown`, `ThinkingSection`, `ToolExecutionBox`) and integration with the 4 Pi skills (`grill-me`, `plan`, `execute`, `verify`).

## Development

```bash
npm install   # dev-only: typescript, @types/node, jiti
npm run typecheck
npm test
```

`npm test` runs `node --test` over `tests/`. It covers the job lifecycle, the editor-key guard, shell
result formatting, and the opt-in review gate. Tests are development-only and are not published.

## Install

```bash
pi install npm:pi-agent-orchestrator
```

Or from a local checkout:

```bash
pi install ./path/to/pi-agent-orchestrator
```

## License

MIT © 2026 tungbach12.
