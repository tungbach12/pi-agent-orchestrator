import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReviewPrompt,
  parseReview,
  runReviewGate,
  verificationEvidence,
} from '../extensions/review.ts';

test('verification evidence accepts completed test commands, not lookalikes or failed checks', () => {
  const failed = verificationEvidence([
    { name: 'bash', input: { command: 'npm test' }, status: 'error', output: 'Tests failed' },
  ]);
  assert.equal(failed.hasSuccessfulCheck, false);

  const lookalike = verificationEvidence([
    { name: 'bash', input: { command: 'echo test' }, status: 'completed', output: 'test' },
  ]);
  assert.equal(lookalike.hasSuccessfulCheck, false);

  const passed = verificationEvidence([
    { name: 'bash', input: { command: 'npm test' }, status: 'completed', exitCode: 0, output: '29 passing' },
  ]);
  assert.equal(passed.hasSuccessfulCheck, true);
  assert.match(passed.text, /npm test/);
});

test('verification evidence uses the latest result for repeated checks and requires all checks to pass', () => {
  const evidence = verificationEvidence([
    { name: 'bash', input: { command: 'npm test' }, status: 'completed', exitCode: 0, output: 'all tests passed' },
    { name: 'bash', input: { command: 'npm run lint' }, status: 'completed', exitCode: 0, output: 'lint passed' },
    { name: 'bash', input: { command: 'npm test' }, status: 'error', exitCode: 1, output: 'Exited with code 1' },
  ]);
  assert.equal(evidence.hasSuccessfulCheck, false, 'a later failing rerun invalidates the earlier pass');
  assert.match(evidence.text, /FAIL\/UNKNOWN(?: \(exit 1\))?: npm test/);
  assert.match(evidence.text, /PASS(?: \(exit 0\))?: npm run lint/);
});

test('mutating lint and snapshot-update commands are not recognized as verification', () => {
  for (const command of [
    'npm run lint -- --fix',
    'npx eslint . --fix',
    'npx vitest run -u',
    'npx vitest run --update',
    'npm test > test.log',
    'cargo fmt',
    'dart format lib/',
    'ruff format .',
    'npx prettier .',
    'npx tsc',
    'cd repo && rm -rf dist && npm test',
  ]) {
    assert.equal(
      verificationEvidence([{ name: 'bash', input: { command }, status: 'completed', output: 'done' }]).hasSuccessfulCheck,
      false,
      `${command} should not count as a clean verification check`,
    );
  }
});

test('read-only formatting checks and multi-repo chained verification commands are recognized as verification evidence', () => {
  for (const command of [
    'cargo fmt --check',
    'cargo fmt -- --check',
    'dart format --output=none lib/',
    'ruff format --check .',
    'npx prettier --check .',
    'npx tsc --noEmit',
    'tsc --noEmit',
    'node --test',
    'python -m pytest',
    'python3 -m unittest',
    'dotnet test',
    'make test',
    'git diff --check',
    'cd /e/Dev/Repos/Capstone/.pi/merge-checkouts/local-frontend-integration && npm test -- --run src/app/layouts/AppShell.test.tsx',
    'cd /e/Dev/Repos/Capstone/.pi/merge-checkouts/local-frontend-integration && npm run lint && npm test -- --run && npm run build',
    'cd /e/Dev/Repos/Capstone/.pi/merge-checkouts/local-backend-integration && ./mvnw.cmd spotless:apply && ./mvnw.cmd verify && git diff --check',
    'cd SmartDroneInspection-mobile && flutter analyze && flutter test',
  ]) {
    assert.equal(
      verificationEvidence([{ name: 'bash', input: { command }, status: 'completed', exitCode: 0, output: 'ok' }]).hasSuccessfulCheck,
      true,
      `${command} should be recognized as a read-only verification check`,
    );
  }
});

test('verification evidence rejects command output that reports timeout or failure despite exit zero', () => {
  for (const output of ['Command timed out after 5 seconds', 'Command aborted', 'ERROR: test runner failed']) {
    assert.equal(
      verificationEvidence([{ name: 'bash', input: { command: 'npm test' }, status: 'completed', exitCode: 0, output }]).hasSuccessfulCheck,
      false,
      `${output} must not count as successful verification`,
    );
  }
});

test('review parser requires exactly one explicit verdict', () => {
  assert.equal(parseReview('VERDICT: PASS\nFINDINGS:\n- NONE').verdict, 'PASS');
  assert.equal(parseReview('VERDICT: PASS\nFINDINGS:\n- src/x.ts:4: missing scope check').verdict, 'UNCERTAIN');
  assert.equal(parseReview('VERDICT: NEEDS_FIX\nFINDINGS:\n- src/x.ts:4: missing scope check').verdict, 'NEEDS_FIX');
  assert.equal(parseReview('VERDICT: NEEDS_FIX\nFINDINGS:\n- NONE').verdict, 'UNCERTAIN');
  assert.equal(parseReview('The implementation looks good.').verdict, 'UNCERTAIN');
  assert.equal(parseReview('VERDICT: PASS\nVERDICT: NEEDS_FIX').verdict, 'UNCERTAIN');
});

test('review requires task criteria and a successful observed check before PASS', () => {
  const prompt = buildReviewPrompt({
    task: 'Add the feature and pass npm test.',
    evidence: { text: 'No check captured', hasSuccessfulCheck: false },
    attempt: 1,
  });
  assert.match(prompt, /A PASS requires all of the following/);
  assert.match(prompt, /A successful recognized check was observed: NO/);
  assert.match(prompt, /Never infer that tests pass from the implementer's prose/);
});

test('review gate accepts a verified implementation on the first review', async () => {
  let reviews = 0;
  let fixes = 0;
  const result = await runReviewGate({
    task: 'Add feature X. Acceptance: X returns 200.',
    implementationTools: [{ name: 'bash', input: { command: 'npm test' }, status: 'completed', exitCode: 0, output: 'pass' }],
    runReview: async () => { reviews++; return 'VERDICT: PASS\nFINDINGS:\n- NONE'; },
    runFix: async () => { fixes++; return { report: '', tools: [] }; },
  });
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.fixRounds, 0);
  assert.equal(reviews, 1);
  assert.equal(fixes, 0);
});

test('review gate permits only one fix and requires fresh successful verification after it', async () => {
  let reviews = 0;
  let fixes = 0;
  const result = await runReviewGate({
    task: 'Add feature X. Acceptance: X returns 200.',
    implementationTools: [{ name: 'bash', input: { command: 'npm test' }, status: 'completed', exitCode: 0, output: 'initial pass' }],
    runReview: async () => {
      reviews++;
      return reviews === 1
        ? 'VERDICT: NEEDS_FIX\nFINDINGS:\n- src/x.ts:4: missing required status handling.'
        : 'VERDICT: PASS\nFINDINGS:\n- NONE';
    },
    runFix: async () => {
      fixes++;
      return {
        report: 'Fixed status handling.',
        tools: [{ name: 'bash', input: { command: 'npm test' }, status: 'completed', exitCode: 0, output: 'passed' }],
      };
    },
  });
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.fixRounds, 1);
  assert.equal(reviews, 2);
  assert.equal(fixes, 1);
});

test('review gate fails closed after unresolved findings or uncertainty', async () => {
  let reviewCalls = 0;
  const result = await runReviewGate({
    task: 'Add feature X.',
    implementationTools: [{ name: 'bash', input: { command: 'npm test' }, status: 'completed', exitCode: 0, output: 'pass' }],
    runReview: async () => {
      reviewCalls++;
      return 'VERDICT: NEEDS_FIX\nFINDINGS:\n- src/x.ts:4: missing requirement.';
    },
    runFix: async () => ({ report: 'No fix evidence.', tools: [] }),
  });
  assert.equal(result.verdict, 'UNCERTAIN');
  assert.equal(result.fixRounds, 1);
  assert.equal(reviewCalls, 2);
});

test('review cannot pass on implementer-reported success without an observed successful check', async () => {
  const result = await runReviewGate({
    task: 'Change code to implement X.',
    implementationTools: [],
    runReview: async () => 'VERDICT: PASS\nFINDINGS:\n- NONE',
    runFix: async () => { throw new Error('must not fix'); },
  });
  assert.equal(result.verdict, 'UNCERTAIN');
  assert.equal(result.fixRounds, 0);
});
