import type { CopiedHook } from './copy'
import type { FailMode } from './launcher'

/** Quotes a word for `sh` so that nothing in it is expanded. */
export const shellQuote = (word: string): string => `'${word.replaceAll('\'', `'\\''`)}'`

export interface CommandOptions {
  /** The fail mode; defaults to `closed`. */
  fail?: FailMode
  /** The lowest Node.js major version the hook runs on; defaults to 22. */
  minNode?: number
  /** Arguments passed to the hook after its entry. */
  args?: readonly string[]
}

/**
 * The `command` of a hook entry that runs a copied hook through its launcher.
 *
 * A missing launcher exits 2 by itself in `closed` and `strict` mode, since
 * `sh` would otherwise answer 127, which the agents read as "go on". `exec`
 * hands the hook's own exit code back unchanged.
 */
export function hookCommand(hook: CopiedHook, { fail = 'closed', minNode = 22, args = [] }: CommandOptions = {}): string {
  const launcher = shellQuote(hook.launcher)
  const run = ['exec', launcher, fail, String(minNode), shellQuote(hook.entry), ...args.map(shellQuote)].join(' ')
  return fail === 'open' ? `[ -x ${launcher} ] && ${run}` : `[ -x ${launcher} ] || exit 2; ${run}`
}

const RUNNER_COMMAND = /^\[ -x '((?:[^']|'\\'')*\/run\.sh)' \]/

/** The launcher path of a command `hookCommand` wrote, or `undefined`. */
export function launcherOf(command: string): string | undefined {
  return RUNNER_COMMAND.exec(command)?.[1]?.replaceAll(`'\\''`, '\'')
}
