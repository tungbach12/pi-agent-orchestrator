import { isAbsolute, relative, resolve } from 'node:path';
import { Type } from 'typebox';

/**
 * A read-only file-modification guard for child agent sessions.
 *
 * Read-only agents (`explore`, `review`, `research`) exclude `edit` and `write`
 * from their tool schema and are instructed via system prompt not to mutate
 * repository state. `createReadOnlyGuard()` enforces that boundary at the
 * `tool_call` hook layer by blocking `write` and `edit` calls (while allowing
 * `bash` commands to run without brittle regex false positives).
 *
 * The guard is installed as an inline extension on the child session only, so
 * the parent session keeps its full tool set.
 */

export interface ReadOnlyVerdict {
  allowed: boolean;
  reason?: string;
}

/** The parameters of a guarded shell call. Pi's bash schema is reused as-is. */
export const ReadOnlyBashParams = Type.Object({
  command: Type.String({ description: 'A read-only shell command.' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds.' })),
});

/**
 * Checks whether a file path is a `.md` plan file inside `<cwd>/.pi/plans/`.
 *
 * The `plan` agent may create and update Markdown plan files in `.pi/plans/`,
 * while all other repository paths remain read-only.
 */
export function isAllowedPlanPath(cwd: string, targetPath: string): ReadOnlyVerdict {
  const trimmed = targetPath.trim();
  if (!trimmed) return { allowed: false, reason: 'The file path is empty.' };
  const plansDir = resolve(cwd, '.pi', 'plans');
  const resolved = resolve(cwd, trimmed);
  const rel = relative(plansDir, resolved);
  const insidePlansDir = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  if (!insidePlansDir || !resolved.toLowerCase().endsWith('.md')) {
    return {
      allowed: false,
      reason: `The plan agent may only write or edit Markdown files inside .pi/plans/ (received "${targetPath}").`,
    };
  }
  return { allowed: true };
}

/** Builds a clean default `.pi/plans/<slug>.md` relative path from a task description. */
export function defaultPlanRelativePath(description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `.pi/plans/${slug || 'plan'}.md`;
}

export interface ReadOnlyGuardOptions {
  cwd?: string;
  /** When true, `write` and `edit` are allowed only for `.md` files inside `<cwd>/.pi/plans/`. */
  allowPlanFiles?: boolean;
}

/**
 * Builds the inline extension that guards a child session against file writes.
 *
 * The handler blocks `write` and `edit` calls in read-only sessions. When
 * `allowPlanFiles: true`, only `.md` files under `.pi/plans/` can be created
 * or updated. Shell (`bash`) commands are governed by the child's read-only
 * system prompt rather than regex filtering.
 */
export function createReadOnlyGuard(options: ReadOnlyGuardOptions = {}): (pi: {
  on(event: 'tool_call', handler: (event: { toolName: string; input: unknown }) => { block?: boolean; reason?: string } | undefined): void;
}) => void {
  return (pi) => {
    pi.on('tool_call', (event) => {
      if (event.toolName === 'write' || event.toolName === 'edit') {
        if (!options.allowPlanFiles || !options.cwd) {
          return {
            block: true,
            reason: 'This session is read-only and cannot modify files.',
          };
        }
        const input = event.input as { path?: unknown } | undefined;
        const targetPath = typeof input?.path === 'string' ? input.path : '';
        const verdict = isAllowedPlanPath(options.cwd, targetPath);
        if (verdict.allowed) return undefined;
        return {
          block: true,
          reason: verdict.reason,
        };
      }
      return undefined;
    });
  };
}
