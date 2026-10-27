<div align="center">

# ⚡ pi-agent-orchestrator

**Parallel Subagents, Background Shell Jobs & Interactive Activity Dock for [Pi](https://github.com/earendil-works/pi)**

[![npm version](https://img.shields.io/npm/v/pi-agent-orchestrator?style=flat-square&color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-agent-orchestrator)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Pi Extension](https://img.shields.io/badge/Pi-Extension-10b981?style=flat-square)](https://github.com/earendil-works/pi)
[![Tests](https://img.shields.io/badge/Tests-60%20passed-22c55e?style=flat-square)](#development)

*Delegate complex exploration, research, coding, and code review to isolated child agents • Run long builds and dev servers in the background without polling • Steer, pause, or inspect everything live in a native TUI dock.*

[**Quick Start**](#-quick-start) · [**Subagent Roles**](#-specialized-subagent-roles) · [**Interactive Lifecycle**](#-interactive-lifecycle--steering) · [**Tools**](#️-tools-reference) · [**Activity Dock**](#️-activity-dock-tui) · [**Architecture Docs**](#-architecture--research-docs)

</div>

---

## ✨ Why `pi-agent-orchestrator`?

By default, an AI coding agent runs a single synchronous loop: a long test suite, a dev server, or a 40-file codebase search blocks the conversation and floods the main context window with raw tool output.

`pi-agent-orchestrator` adds a native multi-agent and background-execution layer on top of Pi:

- **🚀 True Parallelism**: Spawn up to **10 concurrent subagents** (`@explore`, `@code`, `@review`, `@research`, `@general`) in a single turn.
- **🧠 Context Isolation**: Each child agent runs in its own isolated Pi session with role-tailored prompts and tools, returning a distilled report + ground-truth `<telemetry>` to keep the parent context lean.
- **⚡ Zero-Latency Interactivity**:
  - **Send a message (`Enter`)** while subagents or `job_wait` are running $\to$ work is **automatically backgrounded** so the Main Agent replies to you immediately without losing subagent progress.
  - **Press `Esc`** $\to$ stops both the Main Agent and any active subagents immediately while preserving their `sessionID` so saying **`continue`** resumes right where they left off.
  - **Live Mid-Run Steering** $\to$ inject new instructions into an already-running subagent via `subagent({ sessionID, prompt })` without restarting it.
- **🔔 Push Completion Notices (No Polling)**: Background shells and subagents automatically wake the parent session via steering messages when they finish.
- **🛡️ Fail-Closed Review Gate (`review: true`)**: Optional independent reviewer audits code changes against task criteria, mid-run steering updates, and verified test execution before accepting delivery.

---

## 📦 Quick Start

Install directly via Pi's package manager:

```bash
pi install npm:pi-agent-orchestrator
```

Or install from a local checkout during development:

```bash
pi install ./path/to/pi-agent-orchestrator
```

---

## 🤖 Specialized Subagent Roles

Every child session inherits Pi's built-in tools (including `codemode`), plus callable parent tools (`web_search`, `fetch_content`, MCP tools, etc.), filtered through a strict role-based capability matrix:

| Role | Mode | Built-in & Inherited Tools | `review: true` Gate | Primary Use Case |
| :--- | :---: | :--- | :---: | :--- |
| **`@explore`** | 🔒 Read-Only | `read`, `grep`, `find`, `ls`, `bash`, `codemode` + read-only parent tools | — | Fast, parallel codebase navigation and symbol/file discovery |
| **`@research`** | 🔒 Read-Only | `read`, `grep`, `find`, `ls`, `bash`, `codemode` + `web_search`, `fetch_content`, `gh` CLI | — | Deep technical research across external docs, GitHub repos, and local code |
| **`@review`** | 🔒 Read-Only | `read`, `grep`, `find`, `ls`, `bash`, `codemode` + read-only parent tools | — | Senior code & diff auditing with severity-ranked `file:line` findings |
| **`@code`** | ✍️ Read/Write | Full coding toolset (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, `codemode`) + parent tools | ✅ Supported | Scoped feature implementation, bug fixing, and test verification |
| **`@general`** | ✍️ Read/Write | Full coding toolset + parent tools (uses Pi's default system prompt) | ✅ Supported | Open-ended multi-step workflows requiring full tool access |

### Built-in Safety & Reliability Guardrails

- **Two-Layer Read-Only Guard (`createReadOnlyGuard`)**: `@explore`, `@review`, and `@research` exclude `edit` and `write` from their tool schema and enforce a runtime `tool_call` hook blocking file modifications, while leaving `bash` unrestricted for complex multi-repo inspection (`cd repo && git status`, `find`, `rg`).
- **Default Child `bash` Timeout**: Child `bash` calls automatically default to a **120-second timeout** when omitted, preventing runaway filesystem scans (e.g. `find /`) from hanging a subagent indefinitely.
- **4-Stage Handoff Protocol**:
  1. **`expectedOutput` Contract**: Appended to the end of the child prompt for recency focus.
  2. **One-Shot Empty-Completion Nudge**: Automatically recovers if a child executes tools but forgets to emit a final synthesis turn.
  3. **Ground-Truth `<telemetry>`**: Every `<subagent>` completion envelope includes exact tool call counts, modified files, executed commands, and verification status.
  4. **Durable `sessionID` Continuation**: Child sessions are stored under `<parent-session-dir>/subagents/*.jsonl` (hidden from `/resume` clutter) and can be resumed across turns or Pi restarts.

---

## 🔄 Interactive Lifecycle & Steering

```text
User Input / Key          Main Agent State               Subagent / Job Behavior
──────────────────────────────────────────────────────────────────────────────────────────────────
Enter (send message)  ──► Unblocks immediately       ──► Auto-backgrounds active subagents &
                          to answer your message         interrupts job_wait (jobs keep running)

Esc (cancel turn)     ──► Aborts current turn        ──► Aborts active subagents & preserves
                                                         sessionID for instant "continue" resume

"continue" / "tiếp"   ──► Sees <interrupted_subagents> ─► Calls subagent({ sessionID }) to resume
                          system notice                  from existing tool & message history

Steer running agent   ──► Calls subagent({ sessionID, ──► Injects live steering prompt into the
                          prompt: "<new guidance>" })    running child session without aborting
```

### Independent Verification Gate (`review: true`)

When `review: true` is passed to a `@code` or `@general` subagent:
1. The implementer completes its changes and runs project verification commands (`npm test`, `./mvnw test`, `pytest`, `cargo test`, `tsc --noEmit`, `git diff --check`, etc., including multi-repo `cd <repo> && ...` chains).
2. An isolated read-only `@review` agent audits the repository state against both the original task prompt **and** any mid-run steering instructions.
3. If the reviewer returns `NEEDS_FIX`, the implementer is resumed **at most once** to fix the concrete findings and re-run verification before a final re-review.
4. Fails closed if no verification command succeeded or if findings remain unresolved (while always preserving the implementer's full report for inspection).

---

## 🛠️ Tools Reference

All job management tools (`job_wait`, `job_status`, `job_background`, `job_cancel`) accept **either** the exact `UUID` **or** the human-readable subagent `description` / job `title` (exact or substring match).

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| **`subagent`** | `agent`, `description`, `prompt`, `expectedOutput?`, `sessionID?`, `background?`, `review?`, `model?` | Spawn a new child agent (`explore`, `code`, `review`, `research`, `general`), resume a previous child session, or steer a running one via `sessionID`. |
| **`shell`** | `command`, `workdir?`, `timeout?`, `background?` | Execute a shell command. Streams full output to `.pi/shells/<id>.log`, auto-backgrounds persistent dev servers (`vite`, `next dev`, `npm run dev`, etc.) after startup, and applies 32 KB head-tail truncation inline. |
| **`shell_output`** | `shellID`, `offset?`, `limit?` | Read a byte range from a shell log file. Supports negative `offset` (e.g. `-8192`) to tail the latest output. |
| **`job_wait`** | `id`, `timeout?` | Wait for a queued or running job (by UUID or description/title). Automatically unblocks if the user sends a message or presses `Esc`. |
| **`job_status`** | `id` | Inspect the current status, timing, and output of a shell or subagent job (by UUID or description/title). |
| **`job_background`** | `id` | Move a running foreground job to the background. |
| **`job_cancel`** | `id` | Cancel a queued or running shell/subagent job and wait for its process/session to settle. |

---

## 🖥️ Activity Dock (TUI)

Press **`↓` (Down Arrow)** from an empty editor (or run **`/agents`**) to open the live Activity Dock overlay:

```text
╭─ Activity · Subagents (2) · Shell (1) ──────────────────────────────────────────────────────────╮
│ ● @explore  Explore existing docs and templates                       18 tools · 14s · running  │
│ ✓ @code     Implement backend finding query endpoint                  12 tools · 42s · done     │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ↑/↓ select · ←/→ switch tab · Enter inspect transcript · x cancel job · Esc close               │
╰─────────────────────────────────────────────────────────────────────────────────────────────────╯
```

### Keyboard & Mouse Controls

| Key / Input | Context | Action |
| :--- | :--- | :--- |
| **`↓`** *(empty editor)* or **`/agents`** | Main Editor | Open the Activity Dock |
| **`↑` / `↓`** | Dock List | Select subagent or shell job |
| **`←` / `→`** | Dock List | Switch between **Subagents** and **Shell** tabs |
| **`Enter`** | Dock List | Open full-screen **Detail View** for the selected item |
| **`Mouse Wheel`** / **`↑` / `↓`** | Detail View | Smooth, cached sub-millisecond scrolling through large transcripts |
| **`Click`** / **`Enter`** | Detail View | Expand or collapse **Thought** and **Explored** tool groups |
| **`x`** | List / Detail | Cancel the selected running job |
| **`Esc`** / **`←`** | Detail / List | Return to list or close the Activity Dock |

---

## ⚙️ Runtime Defaults

| Setting | Default | Notes |
| :--- | :--- | :--- |
| **Max Concurrent Subagents** | `10` | Additional subagents enter `queued` state and start automatically as slots free up |
| **Shell Concurrency** | Unlimited | Foreground and background shell commands never consume subagent slots |
| **Foreground Shell Timeout** | `120,000 ms` | Background shell runs have no timeout unless explicitly specified |
| **Child `bash` Timeout** | `120 s` | Applied automatically when a child session calls `bash` without a `timeout` |
| **Inline Output Budget** | `32 KB` (`shell`) / `40K chars` (`subagent`) | Uses head-tail truncation so startup context and final errors/summaries are both preserved |
| **Max Subagent Nesting Depth** | `1` | Child sessions run with `noExtensions: true` and cannot recursively spawn subagents |

---

## 📚 Architecture & Research Docs

Deep-dive engineering documentation, empirical benchmarks, and failure-mode analyses are available in [`docs/`](./docs):

1. [**01 — Problem Statement, Failure Taxonomy & Empirical Research**](./docs/01-problem-and-research.md)
   *Quantitative findings from MAST (NeurIPS 2025), Anthropic Multi-Agent Research (+90.2% gain, BrowseComp token-variance analysis), OpenDev, and Task Spec Contracts.*
2. [**02 — System Architecture & Pi Harness Integration**](./docs/02-architecture-and-pi-harness.md)
   *Component diagrams, `DefaultResourceLoader` isolation, `createCodemodeExtension()` integration, Inherit-All + Role Denylist tool resolution (`resolveChildTools`), and durable `SessionManager` linkage.*
3. [**03 — Subagent Roles, Handoff Protocol & Verification Gate**](./docs/03-subagent-roles-and-handoff-protocol.md)
   *Capability matrix for `explore`, `research`, `code`, `review`, and `general`; the 4-stage handoff protocol; `createReadOnlyGuard()`; and the fail-closed `review: true` gate.*
4. [**04 — Background Jobs, Shell Pipeline & Crash Recovery**](./docs/04-background-jobs-and-shell-engine.md)
   *`JobRegistry` state machine, 32 KB Head-Tail truncation, automatic dev-server promotion (`isServerCommand`), negative-offset tail reads, and session-scoped durable recovery (`pi-agent-orchestrator.recovery.v1`).*
5. [**05 — TUI Activity Dock & The 4-Phase Engineering Workflow**](./docs/05-tui-activity-dock-and-workflows.md)
   *Cached sub-millisecond TUI rendering (`Markdown`, `ThinkingSection`, `ToolExecutionBox`) and integration with structured engineering workflows (`grill-me` $\to$ `plan` $\to$ `execute` $\to$ `verify`).*

---

## 🧪 Development

```bash
npm install          # Installs devDependencies (typescript, @types/node, jiti)
npm run typecheck    # Runs tsc --noEmit
npm test             # Runs all 60 unit & integration tests via node --test
```

---

## 📄 License

[MIT](./LICENSE) © 2026 [tungbach12](https://github.com/tungbach12)
