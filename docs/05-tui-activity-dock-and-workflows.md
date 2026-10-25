# 05 — TUI Activity Dock & The 4-Phase Engineering Workflow

This document describes the design of the `ActivityDocument` TUI overlay (`extensions/activity.ts`) and how `pi-agent-orchestrator` pairs with the 4 user-level Pi skills (`grill-me`, `plan`, `execute`, `verify`).

---

## 1. TUI Activity Dock (`extensions/activity.ts`)

The Activity Dock provides real-time observability and control over all running and completed subagents and shell commands without leaving the terminal.

### 1.1 Safe Editor Key Guard (`shouldOpenActivityFromEditorInput`)
The dock opens when the user presses `↓` on an empty editor or runs `/agents`. To guarantee that `↓` never steals focus from normal editing, history navigation, or popups, `shouldOpenActivityFromEditorInput()` enforces three preconditions at input time:
1. `!tui.hasOverlay()` — No modal dialog, selector, or existing overlay is open.
2. `editor.getText().trim().length === 0` — The input editor has no draft text.
3. `!editor.isShowingAutocomplete?.()` — Autocomplete popup is not active.

### 1.2 Main-Session-Matched Detail View
Opening a subagent in the dock (`Enter`) renders its execution transcript using the **exact same `@earendil-works/pi-tui` components and theme tokens** as Pi's main interactive session:

1. **User Prompt Block (`Markdown` + `userMessageBg`)**:
   - Strips the internal `You are a subagent spawned by another session.` preamble.
   - Renders with `new Markdown(cleanPrompt, 1, 1, mdTheme, { color: userMessageText, bgColor: userMessageBg })`, matching `UserMessageComponent`.
2. **Thinking Block (`ThinkingSection`)**:
   - Tracks real thinking intervals (`isThinking`, `thinkingStartedAt`, `thinkingDurationMs`) in `subagent.ts`.
   - Shows `● Thinking · 1.4s` while thinking tokens are streaming, and **freezes the timer** at `▼ Thought · 1.4s` the moment the first tool call or text token starts.
   - Expanded by default (`italic`, `thinkingText` color) and collapsible via `t` or mouse click.
3. **Tool Execution Boxes (`ToolExecutionBox`)**:
   - Each top-level tool call renders inside a `Box` styled with `toolPendingBg` (running), `toolErrorBg` (error), or `toolSuccessBg` (completed), matching `ToolExecutionComponent`.
   - Formats built-in tools in Pi's native compact style:
     - `read path/to/file.ts:1-50` (1-line compact view when collapsed; press `e` or click to expand file content).
     - `grep /pattern/ in src/main` and `find *.ts in src`.
     - `$ command` with a 5-line tail preview and `Elapsed` / `Took` timer.
     - `codemode`: previews the JS script, **groups all nested `parentToolCallId` tool calls inside the `codemode` box** (`✓ grep /foo/ in src 300ms`), strips the `Script completed` header, and shows total duration.
4. **Assistant Response (`Markdown`)**:
   - Streams live assistant text and renders the final report with `new Markdown(child.result.trim(), 1, 0, mdTheme)` so Markdown tables (`┌─┬─┐`), headings, bold text, inline code, and syntax-highlighted code blocks render identically to the main chat.
5. **Width-Safe Framing & Natural Mouse Wheel Scrolling**:
   - Renders detail content at `width - 2` and frames with `bodyLine()` so pre-wrapped component lines never trigger false right-edge `…` clipping.
   - Respects `@earendil-works/pi-tui`'s `wheelDelta` sign convention (negative = scroll up, positive = scroll down).

---

## 2. The 4-Phase Engineering Workflow (`~/.pi/agent/skills/`)

`pi-agent-orchestrator` is designed to power a disciplined 4-phase software engineering workflow via four Agent Skills installed in `~/.pi/agent/skills/`:

```
   [User Request / Feature Idea]
                 │
                 ▼
   ┌──────────────────────────────────────────┐
   │ Phase 1: /skill:grill-me (Main Agent)    │
   │  • Quick recon via `explore` subagent    │
   │  • Challenges hidden assumptions, edge   │
   │    cases, scope fences, and DoD via      │
   │    `ask_user_question`                   │
   └────────────────────┬─────────────────────┘
                        │ Locked Requirement Brief
                        ▼
   ┌──────────────────────────────────────────┐
   │ Phase 2: /skill:plan (Main Agent)        │
   │  • Fans out `explore` (local repo) and   │
   │    `research` (docs/GitHub) in parallel  │
   │  • Writes step-by-step plan to           │
   │    `.pi/plans/<slug>.md`                 │
   └────────────────────┬─────────────────────┘
                        │ Approved `.pi/plans/<slug>.md`
                        ▼
   ┌──────────────────────────────────────────┐
   │ Phase 3: /skill:execute (Main / `code`)  │
   │  • Delegates independent steps to `code` │
   │    subagents with `expectedOutput`       │
   │  • Enforces read-before-edit, minimal    │
   │    diffs, and red-green test runs        │
   └────────────────────┬─────────────────────┘
                        │ Implemented & locally tested
                        ▼
   ┌──────────────────────────────────────────┐
   │ Phase 4: /skill:verify (Main + `review`) │
   │  • Runs actual project test/lint/build   │
   │  • Spawns isolated `review` subagent to  │
   │    audit `git diff` vs `.pi/plans/*.md`  │
   │  • Reports `VERDICT: PASS | NEEDS_FIX`   │
   └──────────────────────────────────────────┘
```

### How the Skills and Subagents Work Together
- **Context Preservation**: `/skill:grill-me` and `/skill:plan` run on the **Main Agent** so no nuance from user Q&A is lost. Heavy file reading is offloaded to `explore` and `research` subagents, keeping the Main Agent's context window small.
- **Persistent Plan Artifact**: `/skill:plan` writes `.pi/plans/<slug>.md` on disk, which serves as the shared source of truth (Blackboard pattern, mitigating MAST **FM-1.4** & **FM-2.4**) for `/skill:execute` and `/skill:verify`.
- **Independent Verification**: `/skill:verify` combines real command execution with an isolated `review` subagent session that has zero prior commitment to the implementation, catching omissions and edge-case bugs before completion.
