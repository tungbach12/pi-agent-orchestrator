# 03 — Subagent Roles, Handoff Protocol & Verification Gate

This document specifies the 5 specialized subagent roles, the 4-stage handoff and verification protocol between Parent and Subagent, the read-only shell guard, and the fail-closed `review: true` gate.

---

## 1. Subagent Capability Matrix

| Role (`AgentKind`) | Mode | Built-in Tools | Inherited Parent Tools (`ctx.tools`) | Excluded Tools (`excludeTools`) | System Prompt | Supports `review: true` | Primary Use Case |
| :--- | :--- | :--- | :--- | :--- | :--- | :---: | :--- |
| **`explore`** | Read-only | `read`, `grep`, `find`, `ls`, guarded `bash`, `codemode` | All non-destructive parent tools (`web_search`, `fetch_content`, `mcp__*`, etc.) | `edit`, `write`, `subagent`, `shell`, `job_*`, `ask_user_question`, `powershell` | `EXPLORE_PROMPT` | No | Fast codebase navigation, symbol/reference discovery, architecture mapping. |
| **`research`** | Read-only | `read`, `grep`, `find`, `ls`, guarded `bash` (`gh` CLI), `codemode` | All non-destructive parent tools (`web_search`, `fetch_content`, `get_search_content`, `source_check`, `mcp__*`) | `edit`, `write`, `subagent`, `shell`, `job_*`, `ask_user_question`, `powershell` | `RESEARCH_PROMPT` | No | Deep research across official docs, external GitHub repos/issues/PRs (`gh`), and local code. |
| **`code`** | Read/Write | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, `codemode` | All non-orchestrator parent tools | `subagent`, `shell`, `job_*`, `ask_user_question`, `powershell` | `CODE_PROMPT` | **Yes** | Scoped feature implementation, bug fixing, refactoring, and running project verification suites. |
| **`review`** | Read-only | `read`, `grep`, `find`, `ls`, guarded `bash` (`git diff/log/status`), `codemode` | All non-destructive parent tools | `edit`, `write`, `subagent`, `shell`, `job_*`, `ask_user_question`, `powershell` | `REVIEW_PROMPT` (or `REVIEWER_GATE_PROMPT`) | No | Standalone code/diff auditing with severity-ranked findings, `file:line` citations, and failure scenarios. |
| **`general`** | Read/Write | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, `codemode` | All non-orchestrator parent tools | `subagent`, `shell`, `job_*`, `ask_user_question`, `powershell` | Pi Default System Prompt | **Yes** | Open-ended multi-step tasks requiring the full toolset and Pi's default persona. |

> **Why is `plan` a Main-Agent Skill (`/skill:plan`) rather than a Subagent?**
> Planning requires full access to the user's prior conversation history and the requirements clarified during `/skill:grill-me`. Running `/skill:plan` on the Main Agent preserves 100% of that conversational context while fanning out heavy read-only exploration to parallel `explore` and `research` subagents, then writing the final plan to `.pi/plans/<slug>.md`.

---

## 2. The 4-Stage Reliable Handoff Protocol

To eliminate cold-start misunderstandings (MAST **FM-1.1**), premature stops (**FM-3.1**), information withholding (**FM-2.4**), and unverified claims (**FM-2.6**), every subagent invocation passes through four protocol gates:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Gate 1: Downward Contract (`formatSubagentPrompt`)                           │
│   [FRESH_PROMPT] + [Task Prompt & Scope] + [REQUIRED OUTPUT CONTRACT]        │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Gate 2: Pre-Settlement Completion Nudge (`EMPTY_COMPLETION_NUDGE`)           │
│   If tools executed > 0 AND assistant text is empty -> prompt once to        │
│   synthesize findings before allowing the child session to settle.           │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Gate 3: Ground-Truth Execution Receipt (`buildExecutionTelemetry`)           │
│   Extracts actual tool counts, modified files, bash commands + exit codes,   │
│   and causal post-edit verification status (`PASS` vs `UNVERIFIED`).         │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Gate 4: Parent Acceptance & `sessionID` Continuation                         │
│   Parent compares prose against `<telemetry>`. If incomplete or unverified,  │
│   Parent calls `subagent({ agent, sessionID, prompt })` to continue.         │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Gate 1: Downward Output Contract (`expectedOutput`)
Callers can pass `expectedOutput` in `subagent` parameters. `formatSubagentPrompt()` places this contract at the **end** of the prompt:

```text
You are a subagent spawned by another session.

<Task prompt, context, and scope boundaries>

REQUIRED OUTPUT CONTRACT (verify every item below is answered with concrete evidence before finishing):
<expectedOutput>
```

### Gate 2: One-Shot Empty Completion Recovery (`EMPTY_COMPLETION_NUDGE`)
When models execute long chains of `grep`/`read`/`codemode` calls, they occasionally emit an end-of-turn stop token without generating a final summary text block (MAST **FM-3.1**, observed in 6.2% of traces).
In `SubagentManager.runChild()`:
- `runToolStart` records `child.tools.length` before `session.prompt(prompt)`.
- If `extractAssistantText()` is empty after `session.prompt(prompt)` completes **and** `child.tools.length > runToolStart`, `runChild()` automatically sends `EMPTY_COMPLETION_NUDGE` once on the same session so the model summarizes the tool results already in its context window.

### Gate 3: Unforgeable `<telemetry>` Envelope (`buildExecutionTelemetry`)
Every completed `<subagent>` tool result wraps the child's output with a machine-generated `<telemetry>` block derived from Pi's `tool_execution_start` and `tool_execution_end` events:

```xml
<subagent sessionID="01a16dc2-..." state="completed" agent="code" description="Fix token expiry">
<telemetry>
Tools: 4 calls (1 read, 2 edit, 1 bash)
Files modified: src/auth/token.ts, tests/auth/token.test.ts
Commands: `npm test` (exit 0)
Verification: PASS (verified after last file edit)
</telemetry>

### Summary of Changes
...
</subagent>
```

**Causal Post-Edit Verification Check**:
`buildExecutionTelemetry()` tracks `lastMutationIndex` (the index of the last completed `edit` or `write` tool call). It runs `verificationEvidence()` **only on tools executed after `lastMutationIndex`**:
- If the subagent ran `npm test` (exit 0) at step 1, edited `src/auth/token.ts` at step 2, and stopped without re-running `npm test`, `<telemetry>` reports:
  `Verification: UNVERIFIED (files were modified without running a verification check after the edit)`
- This prevents stale pre-edit test runs from being mistaken for post-edit verification.

### Gate 4: Parent Acceptance & `sessionID` Continuation
Because `<telemetry>` is part of the model-facing tool result (while hidden from the user's TUI Markdown view to avoid visual noise), the Parent Agent immediately sees:
1. Whether the subagent actually read/searched the expected paths.
2. Which exact files were touched by `edit` / `write`.
3. Whether verification commands actually ran and exited `0` after the last edit.
If any item in `expectedOutput` is missing or `Verification: UNVERIFIED` appears, the Parent resumes the same child conversation via `sessionID`.

---

## 3. Defense-in-Depth Read-Only Guard (`extensions/read-only.ts`)

Read-only subagents (`explore`, `review`, `research`) are protected against modifying files through two layers while retaining unrestricted `bash` access for repository inspection (`cd <repo> && git status`, `git -C <repo> log`, `find -printf`, `rg`, etc.):

1. **Tool Schema & Inheritance Layer (`extensions/types.ts` & `extensions/subagent.ts`)**:
   - Excludes `edit` and `write` from `AGENT_TOOLS` / `AGENT_EXCLUDED_TOOLS`.
   - Filters out any inherited parent/MCP tool marked with `readOnlyHint === false` or `destructiveHint === true`.
2. **Runtime Hook Layer (`createReadOnlyGuard()` in `extensions/read-only.ts`)**:
   - Intercepts Pi's `tool_call` event on the child session and blocks `write` and `edit` calls before execution (or restricts them to `.pi/plans/*.md` when `allowPlanFiles: true`).
   - Leaves `bash` unrestricted by regex heuristics, relying on the role's read-only system prompt so complex inspection commands and multi-repo `git` pipelines never hit false positives.

---

## 4. Independent Fail-Closed Review Gate (`review: true` in `extensions/review.ts`)

For significant `code` or `general` tasks, setting `review: true` activates a two-agent **Implementer -> Independent Reviewer -> Bounded Fix** loop (`runReviewGate`):

1. **Evidence Extraction (`verificationEvidence`)**:
   - Inspects completed `bash` tool records from the implementer's run.
   - Matches only recognized verification executables (`npm`, `pnpm`, `yarn`, `bun`, `node --test`, `python -m pytest/unittest/mypy/ruff`, `mvn`, `gradle`, `cargo`, `go`, `pytest`, `vitest`, `jest`, `flutter`, `dart`, `tsc --noEmit`, `eslint`, `ruff`, `rubocop`, `dotnet`, `make`, `npx`).
   - Rejects mutating flags (`--fix`, `--write`, `-u`, `--updateSnapshot`) and un-checked formatters (`cargo fmt` without `--check`, `npx prettier` without `--check`, `tsc` without `--noEmit`).
   - Deduplicates repeated runs of the same command by keeping the **latest** result, and sets `hasSuccessfulCheck = true` only if **every** check exited `0` with no timeout/abort/FAIL markers.
2. **Isolated Sibling Reviewer (`runReviewer`)**:
   - Spawns a fresh, read-only `review` child session linked to the same parent session.
   - Provides the original task criteria and the captured verification evidence, instructing the reviewer to inspect `git status` / `git diff` and repository files directly rather than trusting the implementer's prose.
3. **Strict Verdict Parsing (`parseReview`)**:
   - Requires exactly one `VERDICT: PASS | NEEDS_FIX | UNCERTAIN` line and a `FINDINGS:` block.
   - Fails closed to `UNCERTAIN` if `VERDICT: PASS` is accompanied by non-`NONE` findings, if `VERDICT: NEEDS_FIX` has `- NONE`, or if `evidence.hasSuccessfulCheck` is `false`.
4. **Single Bounded Fix Round**:
   - If the first review returns `NEEDS_FIX`, the implementer receives `buildFixPrompt()` for **at most one** correction pass and must re-run verification commands before Review Attempt 2 of 2.
   - If Review Attempt 2 does not return `PASS` with `hasSuccessfulCheck === true`, `spawn()` throws a descriptive verification error containing the child `sessionID` and the reviewer's findings.
