import type { FailMode } from './launcher'
import type { Agent } from './settings'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { hookCommand, launcherOf } from './command'
import { copyHook, defaultRoot, planCopy } from './copy'
import { readSettings, settingsFile, writeSettings } from './settings'

export interface AdoptOptions {
  agent: Agent
  /** Defaults to the agent's user settings file. */
  file?: string
  /** Defaults to `~/.agent-hook-runner`. */
  root?: string
  /** Overrides the fail mode for every adopted hook. */
  fail?: FailMode
  /** Overrides the lowest Node.js major version for every adopted hook. */
  minNode?: number
  /** Adopts only the hooks whose command contains this text. */
  only?: string
  /** Reports what would change and writes nothing. */
  dryRun?: boolean
}

export interface AdoptResult {
  event: string
  command: string
  /** The new command, when the hook was (or with `dryRun` would be) adopted. */
  adopted?: string
  /** Why the hook was left as it is. */
  skipped?: string
}

const QUOTED = String.raw`'(?:[^']|'\\'')*'|"[^"$\x60\\]*"`
const WORD = String.raw`[^\s'"\\$\x60;|&<>(){}*?[\]~#]+`
// Words are split on spaces and tabs only: a newline ends a command in sh, so
// a second line is a second command, not an argument.
const NODE_COMMAND = new RegExp(String.raw`^(?:node|/${WORD}/node)[ \t]+(${QUOTED}|/${WORD})((?:[ \t]+(?:${QUOTED}|${WORD}))*?)([ \t]*\|\|[ \t]*exit[ \t]+2)?$`)
const ARG = new RegExp(`${QUOTED}|${WORD}`, 'g')

function unquote(word: string): string {
  if (word.startsWith('\''))
    return word.slice(1, -1).replaceAll(`'\\''`, '\'')
  if (word.startsWith('"'))
    return word.slice(1, -1)
  return word
}

/** A `node <script> [args] [|| exit 2]` command as its parts, or why it is not one. */
export function parseNodeCommand(command: string): { script: string, args: string[], strict: boolean } | string {
  if (launcherOf(command))
    return 'already runs through agent-hook-runner'
  const match = NODE_COMMAND.exec(command.replace(/^[ \t]+|[ \t]+$/g, ''))
  if (!match)
    return 'not a plain `node <absolute script> [args]` command'
  const script = unquote(match[1]!)
  if (!isAbsolute(script))
    return 'its script path is not absolute'
  return {
    script,
    args: (match[2]!.match(ARG) ?? []).map(unquote),
    strict: match[3] !== undefined,
  }
}

// A hook's own package names it and says which Node.js it needs. Without one,
// the file names it, and 18 is the oldest line a hook written today is likely
// to run on.
function describeHook(script: string): { name: string, minNode: number } {
  const fallback = { name: basename(script, extname(script)), minNode: 18 }
  let dir = dirname(script)
  for (let depth = 0; depth < 4; depth++) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
        const major = typeof pkg?.engines?.node === 'string' ? /(\d+)/.exec(pkg.engines.node)?.[1] : undefined
        return { name: typeof pkg?.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : fallback.name, minNode: major ? Number(major) : 18 }
      }
      catch {
        return fallback
      }
    }
    if (dirname(dir) === dir)
      break
    dir = dirname(dir)
  }
  return fallback
}

// Exit 2 blocks the action only on the events where blocking is the point;
// on Stop it would keep the agent from stopping, so a hook that cannot run
// there lets things go on instead.
const BLOCKING_EVENTS = new Set(['PreToolUse', 'UserPromptSubmit', 'PermissionRequest'])

/**
 * Moves every plain `node <script>` hook of a settings file onto a stable copy
 * run by the launcher. The file is backed up beside itself before it changes.
 */
export function adopt({ agent, file = settingsFile(agent), root = defaultRoot(), fail, minNode, only, dryRun = false }: AdoptOptions): AdoptResult[] {
  const settings = readSettings(file)
  const results: AdoptResult[] = []
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (typeof handler !== 'object' || handler === null || handler.type !== 'command' || typeof handler.command !== 'string')
          continue
        const command = handler.command
        if (only !== undefined && !command.includes(only))
          continue
        const parsed = parseNodeCommand(command)
        if (typeof parsed === 'string') {
          results.push({ event, command, skipped: parsed })
          continue
        }
        if (!existsSync(parsed.script)) {
          results.push({ event, command, skipped: `${parsed.script} does not exist` })
          continue
        }
        const mode = fail ?? (parsed.strict ? 'strict' : BLOCKING_EVENTS.has(event) ? 'closed' : 'open')
        const described = describeHook(parsed.script)
        const options = { fail: mode, minNode: minNode ?? described.minNode, args: parsed.args }
        // `node` is where downloaded Node.js builds live.
        const base = described.name.replace(/[^\w.-]/g, '-').replace(/^\.+/, '')
        const name = base === '' ? 'hook' : base === 'node' ? 'node-hook' : base
        let adopted: string
        try {
          planCopy(parsed.script)
          adopted = dryRun
            ? `${name}: ${mode}, Node.js ${options.minNode}+`
            : hookCommand(copyHook({ name, entry: parsed.script, root }), options)
        }
        catch (error) {
          results.push({ event, command, skipped: (error as Error).message })
          continue
        }
        if (!dryRun)
          handler.command = adopted
        results.push({ event, command, adopted })
      }
    }
  }
  if (!dryRun && results.some(result => result.adopted)) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
    copyFileSync(file, `${file}.bak-${stamp}`)
    writeSettings(file, settings)
  }
  return results
}
