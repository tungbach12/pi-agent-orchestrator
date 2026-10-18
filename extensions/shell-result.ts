/**
 * Shell result helpers adapted from OpenCode.
 *
 * Upstream references:
 * - `packages/core/src/tool/plugin/shell.ts` (BACKGROUND_INSTRUCTION)
 * - `packages/core/src/shell/result.ts` (notice)
 */

/** Verbatim from OpenCode packages/core/src/tool/plugin/shell.ts. */
export const BACKGROUND_INSTRUCTION =
  "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes.";

/** Mirrors OpenCode ShellResult.notice. */
export function shellNotice(output: { exit?: number; signal?: string; timeout?: boolean }): string | undefined {
  if (output.timeout) return 'Timed out before completion';
  if (output.signal !== undefined) return `Killed by ${output.signal}`;
  if (output.exit !== undefined && output.exit !== 0) return `Exited with code ${output.exit}`;
  return undefined;
}

/** Mirrors OpenCode resultMessages(): output first, then the background instruction or notice paragraph. */
export function shellResultText(
  output: { output: string; status?: string; exit?: number; signal?: string; timeout?: boolean },
): string {
  const notice =
    output.status === 'running'
      ? BACKGROUND_INSTRUCTION
      : shellNotice({ exit: output.exit, signal: output.signal, timeout: output.timeout });
  return [output.output, notice].filter((part) => part !== undefined && part !== '').join('\n\n');
}
