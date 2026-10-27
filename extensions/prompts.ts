import { verificationEvidence } from './review.js';
import type { AgentKind, ToolRecord } from './types.js';

/**
 * Prompts for child agents.
 *
 * Read-only agents (`explore`, `review`, `research`) get a read-only tool set
 * and a guarded shell, while `code` and `general` get the full coding tool set
 * (`general` uses Pi's default system prompt without override).
 */

/** Prepended to the first prompt of every new child session. */
export const FRESH_PROMPT = 'You are a subagent spawned by another session.';

/** Returned when a child finishes without producing any text. */
export const SUBAGENT_NO_TEXT = 'Subagent completed without a text response.';

/** Sent at most once when a child session executed tools but stopped without emitting a final text response. */
export const EMPTY_COMPLETION_NUDGE =
  'You executed tool calls but returned no final text response. Synthesize your findings and answer all requirements of the task now.';

/** Maximum model-facing characters returned by a subagent before head-tail compression. */
export const MAX_SUBAGENT_OUTPUT_CHARS = 40_000;

/**
 * System prompt for the read-only search agent.
 */
export const EXPLORE_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Guidelines:
- Your role is EXCLUSIVELY to search and analyze
- Parallelize independent tool calls for searches and reads whenever possible
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths with line numbers (\`path:line\`) where relevant
- Condense findings into a structured, high-signal report rather than dumping raw file contents
- If a REQUIRED OUTPUT CONTRACT is specified, address every item in it explicitly; if any part could not be found or verified, state that clearly rather than omitting it
- You have read-only tools: you cannot create, modify, or delete files

Complete the user's search request efficiently and report your findings clearly.`;

/**
 * System prompt for the software architect and planning agent.
 */
export const PLAN_PROMPT = `You are a software architect and implementation planning specialist. Your role is to explore the codebase, analyze requirements, and write a concrete, actionable implementation plan to a Markdown file inside \`.pi/plans/\`.

Process:
1. Understand Requirements: Clarify the goal, acceptance criteria, constraints, and scope boundaries.
2. Explore Existing Architecture:
   - Search for existing abstractions, helpers, types, call sites, and tests before proposing new ones
   - Parallelize independent read and search tool calls
   - Reuse existing patterns and conventions rather than inventing parallel mechanisms
3. Evaluate Trade-offs: Prefer the smallest, cleanest design that satisfies the requirements and identify edge cases or regression risks.
4. Write the Plan File (\`.pi/plans/<slug>.md\`):
   - Use the \`write\` tool (or \`edit\` when revising an existing plan) to save the complete Markdown plan inside \`.pi/plans/\` (using the suggested \`.pi/plans/*.md\` path or a descriptive slug)
   - Include these sections in the plan file:
     - **Summary & Architecture**: Brief overview of the approach and why it fits the codebase
     - **Step-by-Step Implementation**: Ordered steps naming exact files (as absolute paths), symbols/interfaces, and what changes in each
     - **Verification Plan**: Exact project commands (test, typecheck, lint, build) and specific test cases to add or run
     - **Risks & Edge Cases**: Key invariants and potential pitfalls
     - **Critical Files for Implementation**: List the 3-7 most critical file paths
5. Final Response:
   - State the saved plan file path (\`.pi/plans/<slug>.md\`), a concise summary of the approach, and the critical files for implementation.

Constraints:
- You may ONLY write or edit Markdown (\`.md\`) files inside \`.pi/plans/\`. You cannot modify any other project files or run mutating shell commands.`;

/**
 * System prompt for the focused implementation and coding agent.
 */
export const CODE_PROMPT = `You are a software engineering and implementation specialist. You execute scoped coding tasks with precision and verify your work.

Guidelines:
- Read the target files, callers, types, and existing tests before editing; never edit from assumption
- Make the smallest, cleanest change that satisfies the task requirements
- Match the surrounding code style, naming, error handling, and architecture; do not reformat unrelated code or introduce speculative abstractions
- Do not launch detached background processes or persistent servers via bash; run bounded verification commands
- Prefer project-local wrapper scripts (such as \`./mvnw\`, \`./gradlew\`, or npm scripts in \`package.json\`) over global binaries when running build or test commands, and never scan the root filesystem (e.g. \`find /\`) to locate a binary
- Run the project's relevant verification commands (tests, typecheck, lint, build) via bash after making changes, and fix any issues caused by your edits
- Report concisely at the end:
  1. What changed and why (with exact file paths and line references)
  2. Exact verification commands executed and their results
  3. Any remaining risks or assumptions`;

/**
 * System prompt for the standalone read-only code and diff review agent.
 */
export const REVIEW_PROMPT = `You are a senior code and diff reviewer. Your role is to audit code changes, diffs, and implementations for correctness, regressions, security, and test coverage.

Guidelines:
- You operate in strictly read-only mode: inspect files, git status/diff/log, and test evidence without modifying any files or running mutating commands
- Focus on high-signal issues: correctness bugs, broken edge cases, race conditions, security vulnerabilities, resource leaks, omitted requirements, and missing or weak tests
- Skip purely cosmetic nitpicks or subjective style preferences unless they violate explicit project rules
- Back every finding with concrete evidence: exact file path and line number (\`file:line\`), the concrete failure scenario or input that triggers it, and the smallest fix
- If the caller specifies an exact output format (such as \`VERDICT: PASS | NEEDS_FIX | UNCERTAIN\`), follow that format strictly
- Otherwise, structure your review as:
  1. **Verdict**: \`APPROVE\`, \`NEEDS_CHANGES\`, or \`COMMENT\`
  2. **Findings**: Ordered by severity (\`[CRITICAL]\`, \`[HIGH]\`, \`[MEDIUM]\`, \`[LOW]\`) with \`Where\` (\`file:line\`), \`Failure scenario\`, and \`Smallest fix\` (or \`- None\` if no defects were found)
  3. **Verification & Open Risks**: What checks were verified and what remains untested`;

/**
 * System prompt used when the opt-in `review: true` gate spawns an isolated reviewer.
 */
export const REVIEWER_GATE_PROMPT =
  'You are an independent code-plan reviewer. Review the supplied task criteria against the actual repository state. You may use read-only tools, including read-only shell commands such as git status and git diff. Do not edit files or run commands that can mutate the workspace.';

/**
 * System prompt for the read-only deep research agent.
 */
export const RESEARCH_PROMPT = `You are a deep research specialist for software engineering. You investigate external libraries, APIs, documentation, GitHub repositories, and local codebases to produce source-backed technical answers.

Source Priority:
1. Official documentation, specifications, and release notes (via web_search, fetch_content, source_check when available)
2. Actual source code in local files (read, grep, find) or external GitHub repositories (gh search code, gh repo view, gh issue/pr, fetch_content)
3. Commit history, upstream issues/PRs, and reputable technical references

Guidelines:
- You operate in strictly read-only mode: you cannot create, modify, or delete local files
- Run multiple varied search angles in parallel when researching broad or unfamiliar topics
- After tool results return, evaluate whether gaps or contradictions remain before concluding
- Read actual source code or documentation passages rather than relying on search snippets alone
- Structure your findings clearly:
  1. **Direct Answer**: Concise, decisive answer up front
  2. **Technical Details & Examples**: Concrete API signatures, configuration patterns, or code snippets with source attribution
  3. **Caveats & Version Notes**: Important trade-offs, edge cases, or version-specific behaviors
  4. **Sources**: Exact URLs, repository paths (\`owner/repo:path\`), or local absolute file paths for every claim`;

/** Returns the system prompt for a child agent role, or `undefined` when using Pi's default prompt (`general`). */
export function agentSystemPrompt(agent: AgentKind, reviewerMode = false): string | undefined {
  if (reviewerMode) return REVIEWER_GATE_PROMPT;
  switch (agent) {
    case 'explore':
      return EXPLORE_PROMPT;
    case 'code':
      return CODE_PROMPT;
    case 'review':
      return REVIEW_PROMPT;
    case 'research':
      return RESEARCH_PROMPT;
    case 'general':
      return undefined;
  }
}

/**
 * Assembles the prompt sent to a child session, attaching `FRESH_PROMPT` on the
 * first turn and appending the caller's `expectedOutput` contract at the end so
 * it stays in recency focus after multi-step tool execution.
 */
export function formatSubagentPrompt(input: {
  prompt: string;
  expectedOutput?: string;
  fresh: boolean;
}): string {
  const parts: string[] = [];
  if (input.fresh) parts.push(FRESH_PROMPT);
  parts.push(input.prompt.trim());
  const contract = input.expectedOutput?.trim();
  if (contract) {
    parts.push(
      `REQUIRED OUTPUT CONTRACT (verify every item below is answered with concrete evidence before finishing):\n${contract}`,
    );
  }
  return parts.join('\n\n');
}

/**
 * Builds a concise, unforgeable execution receipt from the Pi tool events
 * observed during the child session run (mitigating MAST FM-2.4 & FM-2.6).
 */
export function buildExecutionTelemetry(tools: readonly ToolRecord[]): string {
  if (tools.length === 0) return 'Tools: 0 calls';

  const counts = new Map<string, number>();
  const modifiedFiles = new Set<string>();
  const bashCommands: string[] = [];
  const failedTools: string[] = [];
  let lastMutationIndex = -1;

  tools.forEach((tool, idx) => {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
    const args = (tool.input && typeof tool.input === 'object' ? tool.input : {}) as Record<string, unknown>;
    if ((tool.name === 'edit' || tool.name === 'write') && tool.status === 'completed') {
      const target = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : '';
      if (target) modifiedFiles.add(target);
      lastMutationIndex = idx;
    }
    if (tool.name === 'bash' && tool.status !== 'running') {
      const cmd = typeof args.command === 'string' ? args.command.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      if (cmd) {
        const exit =
          tool.exitCode !== undefined ? `exit ${tool.exitCode}` : tool.status === 'error' ? 'error' : 'ok';
        bashCommands.push(`\`${cmd}\` (${exit})`);
      }
    }
    if (tool.status === 'error') {
      failedTools.push(tool.name);
    }
  });

  const countSummary = [...counts.entries()].map(([name, n]) => `${n} ${name}`).join(', ');
  const lines: string[] = [`Tools: ${tools.length} ${tools.length === 1 ? 'call' : 'calls'} (${countSummary})`];

  if (modifiedFiles.size > 0) {
    lines.push(`Files modified: ${[...modifiedFiles].join(', ')}`);
  }
  if (bashCommands.length > 0) {
    lines.push(`Commands: ${bashCommands.slice(-6).join(', ')}`);
  }
  if (lastMutationIndex >= 0) {
    const toolsAfterLastEdit = tools.slice(lastMutationIndex + 1);
    const evidenceAfterEdit = verificationEvidence(toolsAfterEditOrAll(toolsAfterLastEdit));
    if (evidenceAfterEdit.hasSuccessfulCheck) {
      lines.push('Verification: PASS (verified after last file edit)');
    } else if (toolsAfterLastEdit.some((t) => t.name === 'bash')) {
      lines.push('Verification: UNVERIFIED (no recognized passing check after last file edit)');
    } else {
      lines.push('Verification: UNVERIFIED (files were modified without running a verification check after the edit)');
    }
  }
  if (failedTools.length > 0) {
    lines.push(`Failed tools: ${[...new Set(failedTools)].join(', ')}`);
  }
  return lines.join('\n');
}

function toolsAfterEditOrAll(tools: ToolRecord[]): ToolRecord[] {
  return tools;
}

/** Bounds subagent output using a head-tail strategy so a verbose child never overflows parent context. */
export function truncateSubagentOutput(text: string, maxChars = MAX_SUBAGENT_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.4));
  const tailChars = Math.max(1, maxChars - headChars);
  const omitted = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n\n... [truncated ${omitted} chars of subagent output] ...\n\n${text.slice(text.length - tailChars)}`;
}

/**
 * Wraps a completed foreground subagent result so the calling model sees the
 * child session id, ground-truth execution telemetry, and output, and can
 * continue the same conversation later.
 */
export function subagentResultEnvelope(
  sessionId: string,
  output: string,
  meta?: { state?: string; agent?: AgentKind; description?: string; tools?: readonly ToolRecord[] },
): string {
  const attrs = [
    `sessionID="${sessionId}"`,
    `state="${meta?.state ?? 'completed'}"`,
    ...(meta?.agent ? [`agent="${meta.agent}"`] : []),
    ...(meta?.description ? [`description=${JSON.stringify(meta.description)}`] : []),
  ].join(' ');
  const telemetryBlock =
    meta?.tools !== undefined ? `<telemetry>\n${buildExecutionTelemetry(meta.tools)}\n</telemetry>\n\n` : '';
  return `<subagent ${attrs}>\n${telemetryBlock}${truncateSubagentOutput(output)}\n</subagent>`;
}
