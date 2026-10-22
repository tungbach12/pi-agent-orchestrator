import { Type } from 'typebox';

/**
 * A read-only guard for child agent sessions.
 *
 * The `explore` agent may run shell commands, because a codebase question often
 * needs `git log`, a test run, or a build. What it must not do is change
 * anything. Pi's `tool_call` hook is the native place to enforce that: the
 * handler sees the tool name and the arguments before the tool runs, and can
 * block the call.
 *
 * The guard is installed as an inline extension on the child session only, so
 * the parent session keeps its full tool set.
 */

/** Commands that only read state. Anything else is blocked. */
const READ_ONLY_COMMANDS = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'du',
  'df',
  'pwd',
  'echo',
  'date',
  'whoami',
  'env',
  'printenv',
  'which',
  'type',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  'fd',
  'tree',
  'diff',
  'cmp',
  'sort',
  'uniq',
  'cut',
  'awk',
  'jq',
  'yq',
  'sed', // only with a read-only expression
  'node --version',
  'npm --version',
  'python --version',
  'go version',
  'java -version',
  'mvn -v',
  'gradle -v',
  'docker ps',
  'docker images',
  'kubectl get',
  'psql -c select',
];

/**
 * Read-only subcommands of a tool that also has writing subcommands.
 *
 * The check is on the first two words, so `git log` is allowed while `git
 * commit` is not.
 */
const READ_ONLY_SUBCOMMANDS: Record<string, readonly string[]> = {
  git: [
    'status',
    'log',
    'show',
    'diff',
    'branch',
    'remote',
    'describe',
    'blame',
    'rev-parse',
    'ls-files',
    'ls-tree',
    'shortlog',
    'tag',
    'stash list',
    'config --get',
    'config --list',
    'worktree list',
  ],
  npm: ['ls', 'view', 'outdated', 'explain', 'why'],
  pnpm: ['ls', 'list', 'outdated'],
  yarn: ['list', 'why', 'info'],
  docker: ['ps', 'images', 'inspect', 'logs', 'version'],
  kubectl: ['get', 'describe', 'logs', 'explain', 'version'],
  cargo: ['metadata', 'tree', 'locate-project'],
  go: ['list', 'env', 'version'],
};

/** Substrings that make a command write, whatever the verb says. */
const WRITE_PATTERNS = [
  /\brm\s+(-[a-zA-Z]+\s+)*[^\s]/,
  /\bmv\b/,
  /\bcp\b/,
  /\bmkdir\b/,
  /\brmdir\b/,
  /\btouch\b/,
  /\btruncate\b/,
  /\btee\b/,
  /\bdd\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bchgrp\b/,
  /\binstall\b/,
  /\bln\b/,
  /\bgit\s+(commit|add|push|pull|fetch|merge|rebase|reset|checkout|switch|clean|restore|stash|apply|cherry-pick|revert|tag|init|remote\s+(add|remove|set-url))\b/,
  /\bnpm\s+(install|i|uninstall|remove|publish|pack|init|ci|update|upgrade)\b/,
  /\bnpx\b/,
  /\bpnpm\s+(add|remove|install|update)\b/,
  /\byarn\s+(add|remove|install|upgrade)\b/,
  /\b(curl|wget)\b/,
  /\bpython\b.*\b(urllib|requests)\b/,
  /\bsed\b.*(-i|--in-place)\b/,
  /\btee\b/,
  /\bcat\b.*>/,
  /\bsudo\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkill\b/,
  /\btaskkill\b/,
];

/** Redirects that write to a file. */
const WRITE_REDIRECT = /(^|\s)(>>?|>)\s*\S/;

/**
 * Shell metacharacters that chain a second command.
 *
 * `;` and `&&` are listed because a later command in the chain can write. A pipe
 * is not: `grep foo file | head` is still a read. An escaped `\;`, as used by
 * `find -exec`, is not a chain either.
 */
const CHAIN = /(\|\||&&|(^|[^\\]);|`|\$\()/;

/** A pipe whose next stage also reads. */
const READ_PIPE = /\|\s*(ls|cat|head|tail|wc|grep|egrep|fgrep|rg|find|fd|sort|uniq|cut|awk|jq|yq|diff|file|stat|tr)\b/;

export interface ReadOnlyVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Decides whether a command only reads.
 *
 * The check is deliberately conservative: a command is allowed when its verb is
 * a known read-only one and nothing in it writes. Anything unknown is blocked,
 * because a blocked command costs one retry while an allowed write can change
 * the repository.
 */
export function isReadOnlyCommand(command: string): ReadOnlyVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: 'The command is empty.' };

  // A redirect writes, wherever it appears.
  if (WRITE_REDIRECT.test(trimmed)) {
    return { allowed: false, reason: 'The command redirects output into a file.' };
  }
  for (const pattern of WRITE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `The command can change files (matched ${pattern.source}).` };
    }
  }

  // A chain can hide a write behind a read-only first part. A pipe between two
  // reads is fine, so it is checked separately.
  if (CHAIN.test(trimmed)) {
    return { allowed: false, reason: 'The command chains other commands, which may write.' };
  }
  if (trimmed.includes('|') && !READ_PIPE.test(trimmed)) {
    return { allowed: false, reason: 'The command pipes into something that may write.' };
  }
  const verb = trimmed.split(/\s+/)[0]!.replace(/^["']|["']$/g, '');
  const subcommands = READ_ONLY_SUBCOMMANDS[verb];
  if (subcommands) {
    const rest = trimmed.slice(verb.length).trim();
    const matched = subcommands.some((candidate) => {
      if (!candidate.includes(' ')) return rest === candidate || rest.startsWith(`${candidate} `);
      return rest === candidate || rest.startsWith(`${candidate} `);
    });
    if (!matched) {
      return { allowed: false, reason: `"${verb} ${rest.split(/\s+/)[0] ?? ''}" is not a read-only ${verb} command.` };
    }
    return { allowed: true };
  }
  if (!READ_ONLY_COMMANDS.includes(verb)) {
    return { allowed: false, reason: `"${verb}" is not a known read-only command.` };
  }
  return { allowed: true };
}

/** The parameters of a guarded shell call. Pi's bash schema is reused as-is. */
export const ReadOnlyBashParams = Type.Object({
  command: Type.String({ description: 'A read-only shell command.' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds.' })),
});

/**
 * Builds the inline extension that guards a child session.
 *
 * The handler blocks `bash` calls that would write. Other tools are not
 * blocked here: the child session simply does not have `write` or `edit`
 * registered, so those calls never reach a tool.
 */
export function createReadOnlyGuard(): (pi: {
  on(event: 'tool_call', handler: (event: { toolName: string; input: unknown }) => { block?: boolean; reason?: string } | undefined): void;
}) => void {
  return (pi) => {
    pi.on('tool_call', (event) => {
      if (event.toolName !== 'bash') return undefined;
      const input = event.input as { command?: unknown } | undefined;
      const command = typeof input?.command === 'string' ? input.command : '';
      const verdict = isReadOnlyCommand(command);
      if (verdict.allowed) return undefined;
      return {
        block: true,
        reason: `This session is read-only. ${verdict.reason} Use a read-only command such as ls, grep, find, or git log.`,
      };
    });
  };
}
