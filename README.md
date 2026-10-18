# pi-agent-orchestrator

Run shell work and child agents in parallel from Pi, with automatic completion notifications and a
dock that shows what is running.

The design started from [OpenCode](https://github.com/anomalyco/opencode) — its job lifecycle,
child sessions, and activity grouping are the inspiration — and this package is being developed
independently from there. Expect it to grow beyond that starting point.

## What it gives you

- **`shell`** — run a command in the foreground, or hand it to the background and get on with your
  work. Foreground defaults to a 120-second timeout; background commands have no timeout by default.
  Output streams to a log file as it arrives, and reads are bounded.
- **`subagent`** — delegate a task to a child agent with its own context. `explore` is a read-only
  file-search specialist; `general` handles multi-step work with full tool access. Call it again with
  the returned `sessionID` to continue the same conversation.
- **Jobs** — every command and child agent becomes a job you can inspect, wait on, background, or
  cancel. Failed or interrupted work leaves a receipt instead of disappearing.
- **Completion notifications** — background work wakes the parent session when it finishes. Nothing
  needs to poll; repeated checking is explicitly discouraged in the tool instructions.
- **Activity dock** — a compact `Subagents` / `Shell` view with a full-screen transcript detail:
  expandable Thought and Explored groups, tool history, mouse wheel scrolling, and interruption.

## Using it

Press `↓` with an empty editor — and no active overlay, autocomplete, or history browsing — to open
the dock, or run `/agents`. Inside the dock, `↑`/`↓` move the selection, `←`/`→` switch tabs, and
`Enter` opens the detail view. Arrow keys stay with Pi whenever you are typing, browsing history or
autocomplete, or using a selector, so nothing is taken away from normal editing.

Detail view follows the same transcript shape as the reference: `Esc` or `←` returns to the list,
the mouse wheel scrolls, and Thought/Explored groups toggle on click.

Tools: `shell`, `subagent`, `job_status`, `job_wait`, `job_background`, `job_cancel`, `shell_output`.

## Defaults

- Foreground `shell` timeout is **120,000 ms**; background runs have no timeout unless you pass one.
- Agent steps are **unlimited** by default.
- Subagent nesting depth is limited to **1**.
- A background launch returns a receipt with the ID and an instruction not to poll.
- The `explore` agent keeps its read-only file-search restrictions.
- `general` uses Pi's own system prompt; it is not overridden.

## Where Pi differs from the reference

These are host differences, not behavior we chose to change:

| Reference | Here |
|---|---|
| Custom shell parser and permission service | Pi's `createLocalBashOperations()` and whatever local shell Pi is configured with. Pi exposes no equivalent parser or permission service to extensions. |
| Parent-linked sessions in a durable store | `SessionManager.create(cwd, undefined, { parentSession })` writes a child session file header-linked to its parent, so a child can be continued later, even in a new Pi process. Ephemeral parents fall back to `SessionManager.inMemory`. |
| Synthetic notification messages | `pi.sendMessage(..., { triggerTurn: true, deliverAs: 'followUp' })` delivers completion into the parent session. |
| Long-lived job service | Recovery receipts are Pi custom session entries. Background agents and OS processes are process-local, so nothing resumes automatically after Pi exits — a pending run is reported as interrupted on the next session start. |
| Solid/OpenTUI activity groups | Pi's `ctx.ui.custom`, theme, and normalized mouse events render the dock. |
| Agent registry and permissions | Two fixed roles, `explore` and `general`, built from the tools Pi actually exposes. |

## Development

```bash
npm install   # dev-only: typescript and @types/node, used for typechecking
npm run typecheck
npm test
```

`npm test` runs `node --test` over `tests/`. Six assertions compare this package against real
OpenCode sources and need a local clone; set `OPENCODE_UPSTREAM` to its path to enable them.
Without a clone those checks are skipped and everything else still runs. Tests are development-only
and are not published.

## Install

```bash
pi install npm:pi-agent-orchestrator
```

Or from a local checkout:

```bash
pi install ./path/to/pi-agent-orchestrator
```

## License

MIT. Portions of the prompts and lifecycle design derive from
[OpenCode](https://github.com/anomalyco/opencode), also MIT-licensed; its original copyright notice is
retained in [LICENSE](LICENSE).
