# 01 — Problem Statement, Failure Taxonomy & Empirical Research

This document details the empirical research, quantitative benchmarks, failure taxonomies, and production post-mortems (2024–2026) that motivate the architecture of `pi-agent-orchestrator`.

---

## 1. Why Single-Loop Terminal Agents Hit a Wall

A standard CLI coding agent operates a single sequential ReAct loop (`Reason -> Act -> Observe`). As tasks scale from single-file edits to repository-wide investigations, multi-file refactorings, and full test-suite runs, a single-loop architecture hits four structural bottlenecks:

1. **Blocking I/O & Server Deadlocks**: Running a full test suite, build, or development server (`npm run dev`, `vite`, `uvicorn`) blocks the agent loop until the foreground timeout expires.
2. **Context Window Bloat & Attention Degradation**: Reading 20–40 files or ingesting verbose build logs fills the context window with raw intermediate observations, triggering premature compaction and *lost-in-the-middle* degradation.
3. **Instruction Fade-Out**: Over long tool-call chains (15+ turns), initial constraints and formatting instructions decay in attention weight relative to recent tool outputs.
4. **Epistemic Self-Bias in Verification**: When the same agent session that wrote the code also reviews the code, it shares the same blind spots and assumptions that produced the bug in the first place.

---

## 2. Empirical Benchmarks & Quantitative Findings (2025–2026)

| Source / Study | Methodology & Sample Size | Key Quantitative Findings | Architectural Implication in `pi-agent-orchestrator` |
| :--- | :--- | :--- | :--- |
| **MAST: *"Why Do Multi-Agent LLM Systems Fail?"*** (Cemri et al., UC Berkeley / CMU / UCSD, NeurIPS 2025 / ICLR 2025 Workshop, [arXiv:2503.13657](https://arxiv.org/abs/2503.13657)) | Grounded-theory analysis of **1,600+ execution traces** across **7 multi-agent frameworks** (MetaGPT, ChatDev, HyperAgent, AG2, AppWorld, etc.); inter-annotator agreement **$\kappa = 0.88$**; LLM-as-Judge annotator (**94% accuracy**, **$\kappa = 0.77$**). | • Overall MAS failure rates range from **41.0% to 86.7%**. <br>• **14 failure modes** split into 3 root categories: <br>  1. **FC1 — System & Specification Design**: **39.3%–41.8%** <br>  2. **FC2 — Inter-Agent Misalignment**: **36.9%–37.2%** <br>  3. **FC3 — Task Verification & Termination**: **21.3%–23.5%** (Premature termination **FM-3.1: 6.2%**, Incomplete verification **FM-3.2: 8.2%**, Incorrect verification **FM-3.3: 9.1%**). <br>• Prompt-only fixes improved completion by only **~14%**, proving structural harness gates are required. | Enforces **schema-level tool isolation**, **one-shot pre-settlement nudges** (FM-3.1), **unforgeable `<telemetry>` receipts** (FM-2.6), and an **evidence-gated independent `review` pass** (FM-3.2 / FM-3.3). |
| **Anthropic Engineering: *"How we built our multi-agent research system"*** (Hadfield et al., June 2025, [anthropic.com](https://www.anthropic.com/engineering/multi-agent-research-system)) | Production engineering evaluation of Claude Research (Orchestrator-Worker architecture: Lead Opus 4 + parallel Sonnet 4 subagents) and **BrowseComp** regression analysis. | • Multi-agent orchestrator-worker outperformed single-agent Opus 4 by **+90.2%** on breadth-first research evaluations. <br>• Three-factor regression on BrowseComp explains **95% of performance variance**: **80%** is explained by **total token budget across parallel context windows**, while tool call count and model choice explain the remaining **15%**. <br>• Parallel subagents (3–5 workers) + parallel tool calls cut research wall-clock time by **up to 90%**. <br>• Model-assisted tool description refinement reduced task completion time by **40%**. <br>• Cost trade-off: single agents use **~4×** chat tokens; multi-agent systems use **~15×** chat tokens. | Treats subagents as **intelligent compression filters** (*Focus-on-Descent, Compression-on-Ascent*), supports up to **10 concurrent subagents**, embeds **`codemode`** in every subagent for parallel batched tool calls, and advises direct tool usage for 1–3 file lookups to avoid the 15× token penalty on trivial tasks. |
| **OpenDev: *"Building Effective AI Coding Agents for the Terminal: Scaffolding, Harness, Context Engineering, and Lessons Learned"*** (Nghi D. Q. Bui, March 2026, [arXiv:2603.05344](https://arxiv.org/abs/2603.05344)) | End-to-end systems paper on terminal-native coding agents covering scaffolding, tool harness, context compaction, shell pipeline, and subagent capability matrices. | • Eagerly loading all external MCP tool schemas consumed **~40% of context budget** before the first user turn; lazy discovery reduced baseline overhead to **<5%**. <br>• Partitioning prompts into stable vs. dynamic sections yielded **~88% cost reduction** on cached tokens. <br>• Shell output capped at **30,000 characters** via head-tail truncation prevents build logs from triggering context overflow. <br>• Regex detection across **16 server patterns** auto-promotes dev servers to background execution. | Uses **32 KB Head-Tail inline truncation** (12 KB head + 20 KB tail) for shell output, **40,000-character Head-Tail compression** for subagent handoffs, **auto-promotion of dev servers/watchers** after a **1,500 ms** startup window, and **schema-level `excludeTools`** per subagent role. |
| **Production Study: *"Task Spec Contracts Between Planner and Implementer Agents"*** (Yureki Lab, Aug–Sep 2026, [dev.to](https://dev.to/yureki_lab/how-i-built-a-task-spec-contract-between-my-planner-and-implementer-agents-e94)) | Empirical evaluation of **120 cold-start subagent handoffs** before and after introducing a structured delegation & output contract. | • **Before contract (free-text prose handoffs)**: <br>  - First-pass verifier approval: **57%** (68/120) <br>  - Scope creep / wrong file modified: **31%** (37/120) <br>  - Failed / no useful output: **12%** (15/120) <br>• **After contract (explicit scope fences, acceptance commands, and required output shape)**: <br>  - First-pass verifier approval jumped from **57% to 81%** <br>  - Scope creep / wrong file dropped from **31% to 7%** (a **4.4× reduction** in wasted implementation runs). | Adds explicit **`expectedOutput` contracts** to `SubagentParams` anchored at the end of the child prompt, plus **ground-truth `<telemetry>`** listing exact modified files and verification command exit codes. |

---

## 3. Deep Dive: The 14 MAST Failure Modes & How `pi-agent-orchestrator` Mitigates Them

In Cemri et al. ([arXiv:2503.13657](https://arxiv.org/abs/2503.13657)), multi-agent failures are organized into three categories across Pre-Execution, Execution, and Post-Execution stages:

### Category 1: Specification & System Design Issues (FC1 — 41.8% of failures)
- **FM-1.1 Disobey Task Specification**: The subagent ignores part of the caller's instructions due to prompt length or instruction fade-out.
  - *Mitigation*: `formatSubagentPrompt()` places the caller's `expectedOutput` inside a dedicated `REQUIRED OUTPUT CONTRACT` block at the **very end** of the prompt, exploiting recency attention.
- **FM-1.2 Disobey Role Specification**: A search or review subagent attempts to "fix" code directly, or a child agent recursively spawns more subagents.
  - *Mitigation*: Enforced at **two independent layers**:
    1. **Schema Layer**: `AGENT_EXCLUDED_TOOLS` removes `edit`, `write`, `subagent`, `shell`, `job_*`, and `ask_user_question` from read-only subagent tool schemas (`createAgentSession({ tools, excludeTools })`), and `inheritedParentTools` excludes non-read-only parent tools (`readOnlyHint === false` or `destructiveHint === true`).
    2. **Runtime Hook & Prompt Layer**: `createReadOnlyGuard()` intercepts Pi's `tool_call` event to block `write` and `edit` calls at runtime, while the role-specific system prompt instructs the subagent to use `bash` strictly for read-only inspection.
- **FM-1.3 Step Repetition & Loops**: Subagents repeat the same failing command or spawn recursive agent loops.
  - *Mitigation*: Hard `DEPTH_LIMIT = 1` in `SubagentManager` + `noExtensions: true` on child `DefaultResourceLoader`.
- **FM-1.4 Loss of Conversation History**: Context is lost when follow-up work is dispatched to a brand-new subagent.
  - *Mitigation*: Every child session is a real Pi `SessionManager` JSONL file linked via `parentSession`. Passing `sessionID` reopens the exact session from disk (`resumeChild`) with its full conversation and tool history intact.
- **FM-1.5 Unaware of Termination Conditions**: Subagents do not know what constitutes a complete answer.
  - *Mitigation*: Role-specific system prompts (`EXPLORE_PROMPT`, `CODE_PROMPT`, `REVIEW_PROMPT`, `RESEARCH_PROMPT`) define explicit completion structures and require surfacing `PARTIAL` or `BLOCKED` items rather than silently dropping them.

### Category 2: Inter-Agent Misalignment (FC2 — 36.9% of failures)
- **FM-2.4 Information Withholding**: A subagent discovers critical details during tool execution but omits them from its final prose summary.
- **FM-2.6 Reasoning–Action Mismatch**: A subagent claims in prose *"I updated the file and ran the tests, which passed"* when no test command was actually executed (or the test exited non-zero, or files were edited *after* the test ran).
  - *Mitigation*: `buildExecutionTelemetry()` inspects the actual `ToolRecord[]` captured from Pi's `tool_execution_start` / `tool_execution_end` events and injects an unforgeable `<telemetry>` block into the `<subagent>` envelope:
    - Exact count of tool calls by tool name
    - Exact list of files modified via `edit` / `write`
    - Exact `bash` commands executed and their real `exitCode`
    - Causal verification check: verifies whether a recognized test/typecheck/lint command ran and passed **after the last file modification** (`Verification: PASS` vs. `Verification: UNVERIFIED`).

### Category 3: Task Verification & Termination (FC3 — 21.3% of failures)
- **FM-3.1 Premature Termination**: A subagent executes several tool calls and then terminates its turn with an empty text response.
  - *Mitigation*: `runChild()` detects when `child.tools.length > runToolStart` but the assistant text is empty, and automatically issues a **one-shot pre-settlement continuation nudge** (`EMPTY_COMPLETION_NUDGE`) on the same session so the subagent synthesizes its findings before returning.
- **FM-3.2 No or Incomplete Verification & FM-3.3 Incorrect Verification**: Code changes are accepted without running project checks, or trivial/mutating commands (like `echo test` or `eslint --fix`) are mistaken for verification.
  - *Mitigation*: `review.ts` implements a **fail-closed independent review gate** (`review: true`):
    - `verificationEvidence()` uses a strict allowlist of test/build/lint/typecheck runners (`npm test`, `node --test`, `tsc --noEmit`, `pytest`, `cargo test`, `mvn`, `gradle`, `go test`, `flutter test`, etc.), rejects mutating flags (`--fix`, `-u`, `--write`), rejects exit-0 outputs containing timeout/abort/FAIL markers, and requires **every** latest check to pass.
    - Spawns an isolated sibling `review` subagent with fresh context that inspects the actual repository state and returns a strict `VERDICT: PASS | NEEDS_FIX | UNCERTAIN`.

---

## 4. Production Post-Mortems on Background Tasks & Async Notifications

Real-world incidents in production coding agents (2025–2026) revealed three critical failure modes in background task orchestration:

1. **Cross-Turn & Cross-Session Notification Pollution** (*OpenAI Codex CLI Issue [#14318](https://github.com/openai/codex/issues/14318)*):
   - *Incident*: When a background subagent or command finishes after the parent thread has switched to a different session or task, naive injection callbacks push the completion message into whatever turn/session happens to be active, polluting unrelated context.
   - *How `pi-agent-orchestrator` solves it*: Every job's recovery metadata binds `parentSessionId`. Both live delivery (`deliver()` in `index.ts`) and restart replay (`jobs.pendingDeliveries(activeSessionId)`) verify `activeSessionId === recovery.parentSessionId`. If the user switched to another session, the receipt stays safely persisted in `JobRegistry` and is delivered only when the originating parent session is active again.
2. **Silently Lost Background Completions** (*Claude Code Issues [#85534](https://github.com/anthropics/claude-code/issues/85534) & [#89505](https://github.com/anthropics/claude-code/issues/89505)*):
   - *Incident*: Background task notifications enqueued while the parent pipe is busy or during a session reload are dropped before the model ever sees them, stranding long-running results.
   - *How `pi-agent-orchestrator` solves it*: **At-least-once durable receipts** (`pi-agent-orchestrator.recovery.v1`). When a job is backgrounded, its receipt is persisted immediately via `pi.appendEntry()`. `jobs.completeBackground(notificationId)` removes the receipt **only after** `pi.sendMessage(..., { triggerTurn: true, deliverAs: 'followUp' })` succeeds without throwing. If `sendMessage` throws or Pi restarts mid-job, `session_start` replays the receipt on the next session start.
3. **Foreground Hang on Persistent Dev Servers** (*OpenDev Section 2.4.3 / Appendix E.2, [arXiv:2603.05344](https://arxiv.org/abs/2603.05344)*):
   - *Incident*: Models frequently run `npm run dev`, `vite`, `next dev`, or `tsc --watch` without setting `background: true`, stalling the foreground turn for the full 120-second timeout and then killing the server.
   - *How `pi-agent-orchestrator` solves it*: `isServerCommand()` matches persistent dev-server and watch commands and gives them a **1,500 ms startup grace window** (`SERVER_STARTUP_GRACE_MS`). If the command fails immediately (e.g., port in use or syntax error), the error returns synchronously in the foreground; if it stays alive past 1.5s, it is automatically promoted to a background job and returns the initial startup log plus its `shellID`.

---

## 5. References

1. Cemri, M., Pan, M. Z., Yang, S., Agrawal, L. A., Chopra, B., Tiwari, R., Keutzer, K., Parameswaran, A., Klein, D., Ramchandran, K., Zaharia, M., Gonzalez, J. E., & Stoica, I. (2025). *Why Do Multi-Agent LLM Systems Fail?* NeurIPS 2025 Datasets and Benchmarks / ICLR 2025 Building Trust Workshop. https://arxiv.org/abs/2503.13657
2. Bui, N. D. Q. (2026). *Building Effective AI Coding Agents for the Terminal: Scaffolding, Harness, Context Engineering, and Lessons Learned*. https://arxiv.org/abs/2603.05344
3. Hadfield, J., Zhang, B., Lien, K., Scholz, F., Fox, J., & Ford, D. (2025). *How we built our multi-agent research system*. Anthropic Engineering. https://www.anthropic.com/engineering/multi-agent-research-system
4. Anthropic Engineering (2025). *Effective context engineering for AI agents*. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
5. Young, J. (2025). *Effective harnesses for long-running agents*. Anthropic Engineering. https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
6. Yureki Lab (2026). *How I Built a Task Spec Contract Between My Planner and Implementer Agents*. https://dev.to/yureki_lab/how-i-built-a-task-spec-contract-between-my-planner-and-implementer-agents-e94
7. OpenAI Codex Issue #14318 (2026). *Race condition between subagent async notification and main agent turn lifecycle*. https://github.com/openai/codex/issues/14318
8. Claude Code Issue #85534 (2026). *Background-task completion notification enqueued but never delivered*. https://github.com/anthropics/claude-code/issues/85534
