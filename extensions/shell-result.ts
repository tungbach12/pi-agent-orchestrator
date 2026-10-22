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
