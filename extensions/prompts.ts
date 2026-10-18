/**
 * Agent prompts adapted from OpenCode.
 *
 * Upstream reference: `packages/core/src/plugin/agent.ts`.
 */

/**
 * `explore` keeps OpenCode's system prompt verbatim, followed by a Pi-only tool-name mapping.
 * OpenCode's Read, Grep, Glob, Bash, webfetch, and websearch tools are read, grep, find, bash,
 * fetch_content, and web_search in Pi.
 */
export const EXPLORE_PROMPT_UPSTREAM = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Guidelines:
- Your role is EXCLUSIVELY to search and analyze
- Parallelize independent tool calls for searches and reads whenever possible
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- You MUST NOT create, modify, delete, move, or copy files, including temporary files and reports
- Shell commands MUST be read-only. NEVER run commands that write files or change system state

Complete the user's search request efficiently and report your findings clearly.`;

export const PI_TOOL_MAPPING = `<pi_tool_mapping>
OpenCode's Read, Grep, Glob, Bash, webfetch, and websearch tools correspond to Pi's read, grep, find, bash, fetch_content, and web_search tools. Use the equivalent Pi tools available in your current tool set.
</pi_tool_mapping>`;

export const EXPLORE_PROMPT = `${EXPLORE_PROMPT_UPSTREAM}

${PI_TOOL_MAPPING}`;

/**
 * OpenCode's `general` agent sets no system prompt (only name, description, mode, and permissions),
 * so the port must leave Pi's own system prompt in place instead of substituting one.
 */
export const GENERAL_PROMPT: string | undefined = undefined;

/** The text OpenCode prefixes to a brand-new child session prompt. */
export const FRESH_PROMPT = 'You are a subagent spawned by another session.';

/** OpenCode SubagentCompletion.NO_TEXT. */
export const SUBAGENT_NO_TEXT = 'Subagent completed without a text response.';

/** Mirrors OpenCode's completed-subagent tool content envelope. */
export function subagentResultEnvelope(sessionId: string, output: string): string {
  return `<subagent sessionID="${sessionId}" state="completed">\n${output}\n</subagent>`;
}
