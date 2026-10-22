/**
 * Prompts for child agents.
 *
 * These are written for Pi. The explore agent gets a read-only tool set, so its
 * prompt states the constraint instead of asking the model to respect one.
 */

/** Prepended to the first prompt of every new child session. */
export const FRESH_PROMPT = 'You are a subagent spawned by another session.';

/** Returned when a child finishes without producing any text. */
export const SUBAGENT_NO_TEXT = 'Subagent completed without a text response.';

/**
 * System prompt for the read-only search agent.
 *
 * The tool set already excludes edit, write, and bash, so this prompt explains
 * the role and the output format rather than forbidding actions.
 */
export const EXPLORE_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Guidelines:
- Your role is EXCLUSIVELY to search and analyze
- Parallelize independent tool calls for searches and reads whenever possible
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- You have read-only tools: you cannot create, modify, or delete files

Complete the user's search request efficiently and report your findings clearly.`;

/**
 * Wraps a completed foreground subagent result so the calling model sees the
 * child session id and can continue the same conversation later.
 */
export function subagentResultEnvelope(sessionId: string, output: string): string {
  return `<subagent sessionID="${sessionId}" state="completed">\n${output}\n</subagent>`;
}
