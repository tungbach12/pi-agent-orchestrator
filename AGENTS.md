# Development notes

These notes apply when developing this package from a checkout. They are not needed to install it.

## Target platform

This package targets Pi 1.3.0. Use the APIs Pi itself ships:

- `createAgentSession`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader` from
  `@earendil-works/pi-coding-agent` for child sessions.
- `createLocalBashOperations` for running commands, so the shell behavior matches Pi's own `bash`
  tool (shell selection, process-tree kill, exit-code handling).
- `Theme` from Pi for every color in the dock. Do not hardcode ANSI sequences.
- Pi's own tool names (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`) for child tool sets.

Child sessions are created with `noExtensions: true`. The orchestrator already runs in the parent
session, and loading it again would register the tools twice.

## Rules

- Do not hardcode absolute paths in shipped code. Anything positional must come from `ctx.cwd`,
  `process.env`, or a package-relative resolution.
- Do not import from a package's internal `dist/` paths. Only the public entry point of
  `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` may be imported.
- Keep the tool surface small: a tool the model never calls is dead weight in the prompt.
- Keep tests for `JobRegistry`, the editor-key guard, and the shell result formatting in this
  package.

## Checks

```bash
npm install   # dev-only: typescript, @types/node, jiti
npm run typecheck
npm test
```

`npm test` runs `node --test`, which discovers `tests/` automatically. Tests resolve Pi packages from
`node_modules`, so run `npm install` first; Pi itself loads the shipped TypeScript through jiti.
