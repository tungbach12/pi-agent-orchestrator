# pi-agent-orchestrator

Parallel shell jobs and child agents for [Pi](https://github.com/earendil-works/pi), with automatic
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
Foreground commands default to a 120-second timeout; background commands have none. Output streams to
a log file as it arrives, and reads are bounded so a noisy build cannot flood the context window.
Exit code, signal, and timeout are reported as distinct outcomes rather than collapsed into "failed".

**Child agents**
Delegates a task to an agent with its own context. Two roles are available:

- `explore` — read-only file-search specialist for locating files and answering questions about a
  codebase. It cannot write, and its shell use is restricted to read-only commands.
- `general` — multi-step work with the full tool set.

Child conversations are persisted and linked to their parent, so passing the returned `sessionID`
resumes the same conversation — including after restarting Pi.

**Job lifecycle**
Every command and child agent becomes a job that can be inspected, waited on, moved to the
background, or cancelled. Interrupted work leaves a receipt instead of vanishing silently.

**Completion notifications**
Background work wakes the parent session when it finishes. Polling is unnecessary, and the tool
instructions explicitly discourage it.

**Activity dock**
A compact `Subagents` / `Shell` view, plus a full-screen transcript detail with expandable Thought
and Explored groups, tool history, mouse-wheel scrolling, and interruption.

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
| `subagent` | Delegate to `explore` or `general`; continue with `sessionID` |
| `job_status` | Inspect a job |
| `job_wait` | Block until a job finishes, with an optional timeout |
| `job_background` | Move a foreground job to the background |
| `job_cancel` | Cancel a job |
| `shell_output` | Read a bounded range of a shell's output |

## Defaults

- Foreground `shell` timeout: **120,000 ms**. Background runs: no timeout unless one is passed.
- Agent steps: **unlimited**.
- Subagent nesting depth: **1**.
- A background launch returns a receipt with its ID and an instruction not to poll.
- `general` uses Pi's own system prompt; it is not overridden.

## Design notes

**Durable children, process-local jobs.** Child sessions are real session files linked to their
parent, so they survive a restart. Running OS processes and live agent runtimes do not: they belong
to the Pi process that started them. When Pi exits with work pending, the receipt is reported as
interrupted on the next session start rather than pretending the work finished.

**Completion over polling.** Every background path delivers a message back to the parent session.
The tool descriptions, receipts, and recovery notices all say the same thing, because polling
wastes turns and tokens.

**Arrows belong to the editor.** The dock never takes a global key. It opens only from an empty
editor, and the guard is checked at input time so overlays, autocomplete, history browsing, and
selectors keep working normally.

## Development

```bash
npm install   # dev-only: typescript and @types/node for typechecking
npm run typecheck
npm test
```

`npm test` runs `node --test` over `tests/`. It covers the job lifecycle, the arrow-key guard, and
prompt/result formatting. Six of those checks compare text byte-for-byte against the upstream
reference sources and need a local clone of that repository; set `OPENCODE_UPSTREAM` to its path to
enable them. Without one they are skipped and the rest still run. Tests are development-only and are
not published.

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

This project was inspired by [OpenCode](https://github.com/anomalyco/opencode) and adapts some of its
agent prompt text and result-formatting conventions. Those portions remain under OpenCode's MIT
license; the original notice is reproduced in [LICENSE](LICENSE).
