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
Foreground commands default to a 120-second timeout; background commands have none. Output streams to
a log file under `.pi/shells/` as it arrives, and reads are bounded so a noisy build cannot flood the
context window. Exit code, signal, and timeout are reported as distinct outcomes rather than collapsed
into "failed".

**Child agents**
Delegates a task to an agent with its own context. Two roles are available:

- `explore` — search specialist. It gets Pi's `read`, `grep`, `find`, and `ls` tools, plus a shell that
  is guarded to read-only commands, so it can run `git log` or a build without being able to change
  anything.
- `general` — multi-step work with the full tool set, including `bash`, `edit`, and `write`.

Child conversations are real Pi session files linked to their parent, so passing the returned
`sessionID` resumes the same conversation — including after restarting Pi.

**Read-only guard**
The `explore` agent's shell is filtered through Pi's own `tool_call` hook. A command that writes —
`rm`, `git commit`, `npm install`, a redirect into a file, or a chain that hides one — is blocked
before it runs, and the model gets a message that says which part was rejected. Commands that only
read, including pipes between two reads, go through. The guard applies to the child session only;
the parent session keeps its full tool set.

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
| `subagent` | Delegate to `explore` or `general`; continue with `sessionID` |
| `job_status` | Inspect a job |
| `job_wait` | Block until a job finishes, with an optional timeout |
| `job_background` | Move a foreground job to the background |
| `job_cancel` | Cancel a job |
| `shell_output` | Read a bounded range of a shell's output |

## Defaults

- Foreground `shell` timeout: **120,000 ms**. Background runs: no timeout unless one is passed.
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
npm install   # dev-only: typescript, @types/node, jiti
npm run typecheck
npm test
```

`npm test` runs `node --test` over `tests/`. It covers the job lifecycle, the editor-key guard, and
the shell result formatting. Tests are development-only and are not published.

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
