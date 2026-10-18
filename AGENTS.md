# Development notes

These notes apply when developing this package from a checkout. They are not needed to install it.

## Reference source

OpenCode is the starting point for this package, and the prompts and result formatting still come from
it. Keep a local clone and point `OPENCODE_UPSTREAM` at it:

```bash
git clone --depth=1 https://github.com/anomalyco/opencode.git ../opencode
export OPENCODE_UPSTREAM=../opencode   # PowerShell: $env:OPENCODE_UPSTREAM = "..\opencode"
```

Inspect the clone before changing shell, job, subagent, or activity semantics. The parity tests in
`tests/upstream-parity.test.mjs` read it directly and are skipped when it is absent.

## Rules

- Keep adapted prompt text and result formatting close to the reference, and document each deliberate
  difference in README.md. New behavior that goes beyond the reference is ours to design.
- Do not hardcode absolute paths in shipped code. Anything positional must come from `ctx.cwd`,
  `process.env`, or a package-relative resolution.
- Keep tests for `JobRegistry` and the Pi adapter boundaries in this package.

## Checks

```bash
npm install   # dev-only: typescript and @types/node for typechecking
npm run typecheck
npm test
```

`npm test` runs `node --test`, which discovers `tests/` automatically. Tests resolve Pi packages from
`node_modules`, so run `npm install` first; Pi itself loads the shipped TypeScript through jiti.
