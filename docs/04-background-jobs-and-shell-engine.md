# 04 — Background Jobs, Shell Pipeline & Crash Recovery

This document covers the concurrency model in `JobRegistry`, the streaming shell pipeline in `ShellManager`, automatic dev-server promotion, and durable crash/session recovery.

---

## 1. Job Lifecycle & State Machine (`extensions/jobs.ts`)

Every shell command and child subagent is registered in `JobRegistry` and transitions through a strict state machine:

```
                  ┌────────────┐
   (Slots full)   │   queued   │──► cancel() ──► ┌───────────┐
  ───────────────►└─────┬──────┘                 │ cancelled │
                        │ Slot opens (`pump()`)  └───────────┘
                        ▼                              ▲
  (Slot available)┌────────────┐                       │
  ───────────────►│  running   │──► cancel() ──────────┤ (Waits for process/session
                  └─────┬──────┘    (waits to settle)  │  to stop before freeing slot)
                        │                              │
            ┌───────────┴───────────┐                  │
            ▼                       ▼                  │
     ┌───────────┐           ┌───────────┐             │
     │ completed │           │   error   │             │
     └───────────┘           └───────────┘             │
```

### Key Concurrency Guarantees
1. **Bounded Subagent Pool (`DEFAULT_MAX_CONCURRENT_AGENTS = 10`)**:
   - Up to 10 child subagents run concurrently. When all 10 slots are occupied, additional subagents enter the FIFO `queue` with status `'queued'` and are automatically backgrounded so the parent turn does not deadlock.
2. **Unbounded Shell Execution**:
   - Shell jobs (`type === 'shell'`) never consume subagent slots and never queue behind subagents. A subagent or parent session can always run `shell` commands immediately even when 10 subagents are active.
3. **Cancellation Waits for Settlement**:
   - When `jobs.cancel(id)` is called on a running subagent or shell command, `JobRegistry` invokes the job's `cancel()` callback (`session.abort()` or ` AbortController.abort()`) and **`await`s `job.promise`** before releasing its concurrency slot (`this.activeAgents--`) and calling `this.pump()`.
   - This guarantees a cancelled subagent can never continue mutating files in the background while a newly dequeued subagent starts working on the same repository.
4. **Bounded Consumed History (`CONSUMED_LIMIT = 50`)**:
   - Completed jobs are retained in a 50-entry ring buffer and persisted in session state so `job_status` can still inspect a job after its completion notification has been delivered.

---

## 2. Streaming Shell Pipeline (`extensions/shell.ts` & `extensions/shell-result.ts`)

### 2.1 Process Execution & Log Streaming
- Uses Pi's native `createLocalBashOperations()` so shell selection, environment variables, and process-tree termination (`killProcessTree`) match Pi's built-in `bash` tool across Windows, macOS, and Linux.
- Every command streams stdout/stderr chunks in real time to `.pi/shells/<shellID>.log` while keeping a rolling **64 KB tail** (`MEMORY_TAIL_BYTES`) in memory for live TUI inspection in the Activity Dock.
- Default timeouts:
  - **Foreground (`background: false`)**: `120,000 ms` (2 minutes).
  - **Background (`background: true`)**: `0` (no timeout unless explicitly specified).

### 2.2 Automatic Dev-Server & Watcher Promotion (`isServerCommand`)
To prevent foreground deadlocks when the model launches a persistent server without `background: true` (OpenDev Section 2.4.3 / Appendix E.2, [arXiv:2603.05344](https://arxiv.org/abs/2603.05344)), `isServerCommand()` detects:
- Package manager server/watch scripts: `npm/pnpm/yarn/bun [run] dev | serve | watch | preview`
- Direct framework CLIs: `vite`, `next dev`, `nuxt dev`, `astro dev`, `ng serve`, `webpack serve`, `nodemon`, `flask run`, `fastapi dev`, `uvicorn`, `gunicorn`, `cargo watch`, `http-server`, `live-server`
- Language servers & watchers: `python -m http.server`, `python manage.py runserver`, `tsc --watch`, `vitest --watch`, `jest --watch`, `docker compose up` (without `-d`)

When `background` and `timeout` are omitted on a matching server command:
1. `ShellManager.run()` arms a **`1,500 ms` startup timer** (`SERVER_STARTUP_GRACE_MS`).
2. If the server crashes within 1.5s (e.g., `EADDRINUSE` or syntax error), the error is returned synchronously in the foreground.
3. If the server is still running after 1.5s, `this.jobs.background(shellId)` moves it to the background and returns immediately with its `shellID`, log file path, and the initial startup banner captured during the first 1.5s.

### 2.3 Head-Tail Output Truncation & Negative-Offset Tail Reads
1. **Inline Foreground Output (`inlineOutput`)**:
   - If the log file is $\le 32\text{ KB}$ (`MAX_INLINE_BYTES`), the full output is returned.
   - If the log file exceeds $32\text{ KB}$, `inlineOutput()` reads the **first 12 KB** (`HEAD_INLINE_BYTES`, preserving the command header and first compiler/test errors) and the **last 20 KB** (`TAIL_INLINE_BYTES`, preserving the final test summary and stack trace) with an explicit omission marker pointing to `shell_output({ shellID, offset, limit })` and the `.pi/shells/<id>.log` file path.
2. **Background Completion Envelopes (`shellCompletionEnvelope`)**:
   - Background shell notifications are wrapped in a structured XML envelope with 30,000-character head-tail truncation (40% head + 60% tail):
     ```xml
     <shell shellID="..." state="completed" command="npm test" exit="0" file=".../.pi/shells/....log">
     ...
     </shell>
     ```
3. **Random-Access & Tail Reading via `shell_output`**:
   - Supports positive byte `offset` (from the start of the log file) up to `1 MiB` per read (`MAX_READ_BYTES`).
   - Supports **negative byte `offset`** (e.g., `offset: -8192`, `limit: 8192`) to read the last $N$ bytes from the end of a growing log file without needing to know its total size first.

---

## 3. Durable Delivery & Crash Recovery Protocol

To prevent both **lost notifications** (Claude Code `#85534`) and **cross-session notification pollution** (Codex `#14318`), `JobRegistry` and `index.ts` implement a two-phase durable receipt protocol under custom entry type `pi-agent-orchestrator.recovery.v1`:

| Lifecycle Event | Behavior |
| :--- | :--- |
| **Job Backgrounded (`jobs.background(id)`)** | Assigns a `notificationId` UUID, records a `Recoverable` entry containing `{ jobId, notificationId, recovery: { kind, parentSessionId, ... }, status }`, and persists it to the session transcript via `pi.appendEntry()`. |
| **Job Settled in Same Session (`deliver(info)`)** | Checks `ctx?.sessionManager.getSessionId() === recovery.parentSessionId`. Calls `pi.sendMessage(..., { triggerTurn: true, deliverAs: 'followUp' })`. **Only if `sendMessage` succeeds** does `jobs.completeBackground(notificationId)` remove the recoverable receipt. |
| **Job Settled While User Switched Sessions** | `deliver()` sees `activeSessionId !== recovery.parentSessionId` and **defers delivery**, leaving the receipt in `JobRegistry`. When the user switches back to the originating session (`session_start`), `recoverPending()` delivers the completed result to the right session. |
| **In-Process Session Switch (`session_shutdown` with `reason !== 'quit'`)** | Foreground jobs blocking the old session are moved to the background via `jobs.backgroundAll(sessionId)` so they continue running in-process and report back when finished. |
| **Process Quit / Crash (`session_shutdown` with `reason === 'quit'`)** | Moves all pending foreground jobs to background receipts, aborts in-process runners with reason `'Interrupted because Pi shut down before the job completed.'`, and persists their receipts. On the next Pi startup (`session_start`), `recoverPending()` reports those jobs clearly as interrupted (`state="cancelled"`) rather than silently dropping them or pretending they succeeded. |
