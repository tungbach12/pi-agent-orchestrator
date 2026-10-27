import type { ToolRecord } from './types.js';

export type ReviewVerdict = 'PASS' | 'NEEDS_FIX' | 'UNCERTAIN';

export interface ParsedReview {
  verdict: ReviewVerdict;
  text: string;
}

export interface VerificationEvidence {
  text: string;
  hasSuccessfulCheck: boolean;
}

export interface ReviewGateResult {
  verdict: ReviewVerdict;
  review: string;
  fixRounds: number;
}

/**
 * Captures actual completed shell-tool checks from Pi tool events.
 *
 * This intentionally uses a small command allowlist rather than matching the
 * word "test" anywhere in a command (which would accept e.g. `echo test`).
 * The reviewer still judges whether the captured check covers the task.
 */
export function verificationEvidence(tools: ToolRecord[]): VerificationEvidence {
  const latestChecks = new Map<string, ToolRecord>();
  for (const tool of tools) {
    if (tool.name !== 'bash' || tool.status === 'running' || !isVerificationCommand(tool)) continue;
    const command = String((tool.input as { command?: unknown } | undefined)?.command ?? '').trim();
    latestChecks.set(command, tool);
  }
  const allChecks = [...latestChecks.values()];
  const checks = allChecks.slice(-8);
  if (checks.length === 0) {
    return {
      text: 'No recognized verification command was observed in completed Pi bash tool events.',
      hasSuccessfulCheck: false,
    };
  }

  return {
    text: checks.map((tool, index) => {
      const command = String((tool.input as { command?: unknown } | undefined)?.command ?? '(command unavailable)');
      const output = tool.output ?? '(no textual output)';
      const tail = output.length > 3000 ? `…(truncated)…\n${output.slice(-3000)}` : output;
      const exit = tool.exitCode === undefined ? '' : ` (exit ${tool.exitCode})`;
      return `${index + 1}. ${successfulCheck(tool) ? 'PASS' : 'FAIL/UNKNOWN'}${exit}: ${command}\n${tail}`;
    }).join('\n\n'),
    hasSuccessfulCheck: allChecks.length <= 8 && allChecks.every(successfulCheck),
  };
}

function successfulCheck(tool: ToolRecord): boolean {
  if (tool.status !== 'completed' || tool.exitCode !== 0) return false;
  const output = tool.output ?? '';
  return !/(?:Command timed out after|Timed out before completion|Command aborted|Killed by \w+|Command cancelled|\b(?:FAIL|FAILED|BUILD FAILED|ERROR)\b)/i.test(output);
}

function stripQuotes(text: string): string {
  return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
}

function isSingleVerificationSegment(segment: string): boolean {
  let trimmed = segment.trim();
  if (!trimmed) return false;

  // Strip leading environment variable assignments (e.g. `CI=true MSYS_NO_PATHCONV=1 npm test`)
  while (/^[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/i.test(trimmed)) {
    trimmed = trimmed.replace(/^[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/i, '').trim();
  }
  if (!trimmed) return false;

  const normalized = trimmed.toLowerCase().replace(/\\/g, '/');
  if (/\b(?:sudo|env|command|time|nohup)\b/.test(normalized)) return false;
  const executable = normalized.match(/^(?:\.\/)?(?:\S*\/)?([\w.-]+)(?:\s|$)/)?.[1];
  const args = normalized.slice(normalized.indexOf(executable ?? '') + (executable?.length ?? 0)).trim();
  if (!executable) return false;

  const hasMutationFlag = /(?:^|\s)(?:--fix|--write|--updateSnapshot|--update-snapshot|--update|-u)(?:\s|$)/.test(args);

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    const allowed = /^(?:run\s+)?(?:test|check|verify|lint|typecheck|build|compile|analyze|analyse|test:.*|lint:.*|build:.*)(?:\s|$)/.test(args);
    return allowed && !hasMutationFlag;
  }
  if (executable === 'node') {
    return /(?:^|\s)--test(?:\s|$)/.test(args) && !hasMutationFlag;
  }
  if (executable === 'python' || executable === 'python3') {
    return /^-m\s+(?:pytest|unittest|mypy|ruff\s+(?:check|format\s+--check))(?:\s|$)/.test(args) && !hasMutationFlag;
  }
  if (executable === 'dotnet' || executable === 'make') {
    return /^(?:test|check|verify|lint|typecheck|build)(?:\s|$)/.test(args) && !hasMutationFlag;
  }
  if (executable === 'git') {
    return /^(?:-c\s+\S+\s+|--no-pager\s+)*diff\s+--check(?:\s|$)/.test(args);
  }
  if (['mvn', 'mvnw', 'mvnw.cmd', 'gradle', 'gradlew', 'gradlew.bat', 'cargo', 'go', 'pytest', 'vitest', 'jest', 'flutter', 'dart', 'tsc', 'eslint', 'ruff', 'rubocop', 'npx'].includes(executable)) {
    const allowed = /\b(test|check|verify|lint|typecheck|build|compile|analyze|analyse|vet|clippy|fmt|format)\b/.test(args) ||
      ['pytest', 'vitest', 'jest', 'ruff'].includes(executable) ||
      (executable === 'tsc' && /--noemit\b/.test(args)) ||
      (executable === 'npx' && /^(?:--no-install\s+)?(?:vitest|jest|eslint|tsc|mocha|prettier)(?:\s|$)/.test(args));
    if (executable === 'cargo' && /(?:^|\s)fmt(?:\s|$)/.test(args) && !/--check\b/.test(args)) return false;
    if (executable === 'dart' && /^format\b/.test(args) && !/(?:--output=none|-o\s+none|--set-exit-if-changed)\b/.test(args)) return false;
    if ((executable === 'npx' || executable === 'tsc') && (executable === 'tsc' || /\btsc\b/.test(args)) && !/--noemit\b/.test(args)) return false;
    if (executable === 'npx' && /\bprettier\b/.test(args) && !/(?:--check|--list-different)\b/.test(args)) return false;
    if (executable === 'ruff' && /(?:^|\s)format(?:\s|$)/.test(args) && !/--check\b/.test(args)) return false;
    return allowed && !hasMutationFlag;
  }
  return false;
}

function isAllowedChainHelperSegment(segment: string): boolean {
  const trimmed = segment.trim().toLowerCase().replace(/\\/g, '/');
  if (!trimmed) return true;
  if (/^(?:cd|pushd|popd|pwd|true)\b/.test(trimmed)) return true;
  // Allow spotless:apply / format steps when chained before a real verification check (e.g. `./mvnw spotless:apply && ./mvnw verify`)
  if (/^(?:\.\/)?(?:\S*\/)?(?:mvn|mvnw|mvnw\.cmd|gradle|gradlew|gradlew\.bat)\s+.*\bspotless:apply\b/.test(trimmed)) {
    return true;
  }
  if (/^git\s+(?:status|diff|add)\b/.test(trimmed)) return true;
  return false;
}

function isVerificationCommand(tool: ToolRecord): boolean {
  const command = String((tool.input as { command?: unknown } | undefined)?.command ?? '').trim();
  if (!command) return false;
  const unquoted = stripQuotes(command);
  if (/[|<>`]|\|\||;\s*\S/.test(unquoted) || unquoted.includes('$(')) return false;

  const segments = command
    .replace(/\\\r?\n/g, ' ')
    .split(/\s*&&\s*|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;

  let hasVerificationSegment = false;
  for (const seg of segments) {
    if (isSingleVerificationSegment(seg)) {
      hasVerificationSegment = true;
    } else if (!isAllowedChainHelperSegment(seg)) {
      return false;
    }
  }
  return hasVerificationSegment;
}

/** Builds one fresh-context, read-only review request for the exact task. */
export function buildReviewPrompt(input: {
  task: string;
  evidence: VerificationEvidence;
  attempt: number;
  priorFindings?: string;
}): string {
  return `Review attempt ${input.attempt} of 2.

ORIGINAL TASK / PLAN / ACCEPTANCE CRITERIA:
${input.task}

${input.priorFindings ? `PRIOR REVIEW FINDINGS TO CHECK AGAINST THE UPDATED DIFF:\n${input.priorFindings}\n` : ''}
Do not rely on the implementer's summary. Inspect the current repository state yourself.

CAPTURED VERIFICATION TOOL CALLS (observed from Pi execution events):
${input.evidence.text}

A successful recognized check was observed: ${input.evidence.hasSuccessfulCheck ? 'YES' : 'NO'}.

Inspect the current repository state and the relevant diff/files yourself using read-only tools. The workspace may contain unrelated pre-existing edits: review only changes clearly relevant to this task. If you cannot distinguish task changes from unrelated changes, return UNCERTAIN. Do not edit files or run mutating commands.

Evaluate only correctness against the original task, omitted requirements, regression risk evident from the code, required tests/verification, and scope creep. Do not request cosmetic changes or speculative refactors. Require concrete evidence (file path and line or exact command output) for every finding.

A PASS requires all of the following: the task states observable acceptance criteria; every explicit criterion is met; no material in-scope defect is visible; and, when the task changes code, the evidence flag above is YES. The flag is computed from completed Pi bash tool events, not the command text or implementer's claims. Never infer that tests pass from the implementer's prose. If criteria are ambiguous, evidence is missing/failed, or you cannot confidently check a requirement, return UNCERTAIN rather than PASS.

Return exactly this structure, with no other verdict line:
VERDICT: PASS | NEEDS_FIX | UNCERTAIN
FINDINGS:
- NONE
or one or more concise, actionable findings with file:line evidence and the criterion affected.`;
}

/** Parse a single explicit verdict. Missing/malformed verdicts fail closed. */
export function parseReview(text: string): ParsedReview {
  const matches = [...text.matchAll(/^\s*VERDICT:\s*(PASS|NEEDS_FIX|UNCERTAIN)\s*$/gim)];
  if (matches.length !== 1) return { verdict: 'UNCERTAIN', text };

  const verdict = matches[0]![1] as ReviewVerdict;
  const findings = text.match(/^FINDINGS:\s*\n([\s\S]*)$/im)?.[1]?.trim();
  if (!findings) return { verdict: 'UNCERTAIN', text };
  if (verdict === 'PASS' && findings !== '- NONE') return { verdict: 'UNCERTAIN', text };
  if (verdict === 'NEEDS_FIX' && findings === '- NONE') return { verdict: 'UNCERTAIN', text };
  return { verdict, text };
}

/** Runs one isolated review and, at most, one bounded fix-and-review round. */
export async function runReviewGate(input: {
  task: string;
  implementationTools: ToolRecord[];
  runReview: (prompt: string, attempt: number, priorFindings?: string) => Promise<string>;
  runFix: (prompt: string) => Promise<{ report: string; tools: ToolRecord[] }>;
}): Promise<ReviewGateResult> {
  let evidence = verificationEvidence(input.implementationTools);
  let prompt = buildReviewPrompt({ task: input.task, evidence, attempt: 1 });
  let reviewText = await input.runReview(prompt, 1);
  let review = parseReview(reviewText);

  if (review.verdict === 'PASS' && evidence.hasSuccessfulCheck) {
    return { verdict: 'PASS', review: reviewText, fixRounds: 0 };
  }
  if (review.verdict !== 'NEEDS_FIX') {
    return { verdict: 'UNCERTAIN', review: reviewText, fixRounds: 0 };
  }

  const revision = await input.runFix(buildFixPrompt(input.task, reviewText));
  evidence = verificationEvidence(revision.tools);
  prompt = buildReviewPrompt({ task: input.task, evidence, attempt: 2, priorFindings: reviewText });
  reviewText = await input.runReview(prompt, 2, reviewText);
  review = parseReview(reviewText);

  if (review.verdict === 'PASS' && evidence.hasSuccessfulCheck) {
    return {
      verdict: 'PASS',
      review: reviewText,
      fixRounds: 1,
    };
  }
  return { verdict: 'UNCERTAIN', review: reviewText, fixRounds: 1 };
}

/** Give the implementer one bounded, evidence-based correction opportunity. */
export function buildFixPrompt(task: string, review: string): string {
  return `The independent reviewer did not approve the implementation. Make one focused correction pass.

ORIGINAL TASK / PLAN:
${task}

REVIEW FINDINGS:
${review}

Address only concrete findings supported by code and task criteria. If a finding is mistaken or cannot be resolved safely, explain that in your final report rather than expanding scope. Run the relevant project verification commands and include the exact commands and results. Do not claim checks passed unless their tool calls actually succeed.`;
}
