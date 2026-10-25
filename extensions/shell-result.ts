/**
 * Result formatting for the shell tool.
 */

/**
 * Appended to a background shell result.
 *
 * The model already receives an automatic completion notification, so this only
 * has to say what not to do. Kept short on purpose: it is repeated in the
 * transcript for every background command.
 */
export const BACKGROUND_INSTRUCTION =
  'The parent session is notified automatically when this command finishes. Do not sleep or poll for completion. Keep working on something that does not depend on the result; if there is nothing else to do, end your response.';

/** Maximum model-facing characters returned inline before head-tail truncation. */
export const MAX_INLINE_OUTPUT_CHARS = 30_000;

/**
 * Patterns for long-running development servers and watchers that are never
 * meant to exit on their own in a foreground turn.
 */
const SERVER_COMMAND_PATTERNS: readonly RegExp[] = [
  /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|serve|watch|preview)(?:\s|$)/i,
  /(?:^|\s)(?:npx|bunx|pnpm\s+exec)\s+(?:vite|next\s+dev|nuxt\s+dev|astro\s+dev|ng\s+serve|webpack\s+serve|http-server|live-server|nodemon)(?:\s|$)/i,
  /^\s*(?:vite|next\s+dev|nuxt\s+dev|astro\s+dev|ng\s+serve|webpack\s+serve|nodemon|flask\s+run|fastapi\s+dev|uvicorn\b|gunicorn\b|cargo\s+watch)(?:\s|$)/i,
  /(?:^|\s)python(?:3)?\s+-m\s+http\.server(?:\s|$)/i,
  /(?:^|\s)python(?:3)?\s+manage\.py\s+runserver(?:\s|$)/i,
  /(?:^|\s)(?:tsc|vitest|jest)\b[^\n;&|]*\s(?:--watch|-w)(?:\s|$)/i,
  /^\s*docker(?:\s+compose|-compose)\s+up(?!\s+.*(?:-d|--detach|--abort-on-container-exit))(?:\s|$)/i,
];

/**
 * Detects whether a command launches a persistent dev server or file watcher
 * that should auto-promote to the background after its startup window.
 */
export function isServerCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /(?:--help|-h|--version|-v)(?:\s|$)/.test(trimmed)) return false;
  return SERVER_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Truncates long output using a head-tail strategy (first 40% + last 60%) so
 * both the startup banner/first error and the final summary/stack trace remain
 * visible without flooding the parent context window.
 */
export function truncateHeadTail(
  text: string,
  maxChars = MAX_INLINE_OUTPUT_CHARS,
  meta?: { shellID?: string; file?: string },
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const headChars = Math.max(1, Math.floor(maxChars * 0.4));
  const tailChars = Math.max(1, maxChars - headChars);
  const omitted = text.length - headChars - tailChars;
  const pointer = meta?.shellID
    ? `use shell_output({ shellID: "${meta.shellID}", offset, limit })${meta.file ? ` or inspect ${meta.file}` : ''}`
    : meta?.file
      ? `full log in ${meta.file}`
      : 'use shell_output with offset/limit';
  const marker = `\n\n... [truncated ${omitted} chars; ${pointer}] ...\n\n`;
  return {
    text: `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`,
    truncated: true,
  };
}

/**
 * Wraps a completed background shell command in a structured envelope so the
 * parent session can attribute the output to the exact command and shell ID.
 */
export function shellCompletionEnvelope(input: {
  shellID: string;
  state: string;
  command: string;
  output: string;
  exit?: number;
  file?: string;
}): string {
  const attrs = [
    `shellID="${input.shellID}"`,
    `state="${input.state}"`,
    `command=${JSON.stringify(input.command)}`,
    ...(input.exit !== undefined ? [`exit="${input.exit}"`] : []),
    ...(input.file ? [`file=${JSON.stringify(input.file)}`] : []),
  ].join(' ');
  const { text } = truncateHeadTail(input.output, MAX_INLINE_OUTPUT_CHARS, {
    shellID: input.shellID,
    file: input.file,
  });
  return `<shell ${attrs}>\n${text}\n</shell>`;
}

/** Describes how a command ended, when it ended in a way worth reporting. */
export function shellNotice(output: { exit?: number; signal?: string; timeout?: boolean }): string | undefined {
  if (output.timeout) return 'Timed out before completion';
  if (output.signal !== undefined) return `Killed by ${output.signal}`;
  if (output.exit !== undefined && output.exit !== 0) return `Exited with code ${output.exit}`;
  return undefined;
}

/**
 * Builds the text a shell tool call returns: the output first, then a single
 * trailing paragraph for the background instruction or the exit notice.
 */
export function shellResultText(
  output: { output: string; status?: string; exit?: number; signal?: string; timeout?: boolean },
): string {
  const notice =
    output.status === 'running'
      ? BACKGROUND_INSTRUCTION
      : shellNotice({ exit: output.exit, signal: output.signal, timeout: output.timeout });
  return [output.output, notice].filter((part) => part !== undefined && part !== '').join('\n\n');
}