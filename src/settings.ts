import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

export type Agent = 'claude' | 'codex'

export const AGENTS = {
  claude: { dir: '.claude', file: 'settings.json' },
  codex: { dir: '.codex', file: 'hooks.json' },
} as const satisfies Record<Agent, { dir: string, file: string }>

export interface Handler {
  type?: string
  command?: unknown
  timeout?: number
  statusMessage?: string
  [key: string]: unknown
}
export interface MatcherGroup {
  matcher?: string
  hooks?: Handler[]
  [key: string]: unknown
}
export interface Settings {
  hooks?: Record<string, MatcherGroup[] | null> | null
  [key: string]: unknown
}

/** The user's (or with `project`, the working directory's) hook file of an agent. */
export function settingsFile(agent: Agent, project = false): string {
  const { dir, file } = AGENTS[agent]
  return join(project ? process.cwd() : homedir(), dir, file)
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Reads a settings file, or `{}` when there is none. A `null` where the hooks
 * object or an event's list would go is read as absent, as the agents do; any
 * other shape is refused, because rewriting it would drop what the agent reads.
 */
export function readSettings(file: string): Settings {
  if (!existsSync(file))
    return {}
  let settings: unknown
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'))
  }
  catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}); it was left unchanged`)
  }
  const hooks = isObject(settings) ? settings.hooks : undefined
  const wrongHooks = hooks !== undefined && hooks !== null && !isObject(hooks)
  const wrongEvent = isObject(hooks) && Object.values(hooks).some(list => list !== null && !Array.isArray(list))
  if (!isObject(settings) || wrongHooks || wrongEvent)
    throw new Error(`${file} does not hold a settings object whose hooks map each event to a list; it was left unchanged`)
  return settings as Settings
}

/**
 * Writes the file through a temporary sibling and a rename, so the agent never
 * reads a half-written settings file. A symbolic link, as dotfile managers
 * leave, keeps pointing at the file it points at, which is the one replaced.
 */
export function writeSettings(file: string, settings: Settings): void {
  mkdirSync(dirname(file), { recursive: true })
  const target = existsSync(file) ? realpathSync(file) : file
  const staging = `${target}.${process.pid}.tmp`
  writeFileSync(staging, `${JSON.stringify(settings, null, 2)}\n`)
  renameSync(staging, target)
}

export interface EntryOptions {
  /** Defaults to `PreToolUse`. */
  event?: string
  matcher?: string
  command: string
  timeout?: number
  statusMessage?: string
  /** Earlier commands of this hook, dropped before the new entry is added. */
  replaces: (command: string) => boolean
}

function withoutOwn(groups: MatcherGroup[] | null | undefined, replaces: (command: string) => boolean): MatcherGroup[] {
  return (groups ?? [])
    .map(group => Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter(h => !(typeof h?.command === 'string' && replaces(h.command))) } : group)
    .filter(group => !Array.isArray(group?.hooks) || group.hooks.length > 0)
}

/**
 * Adds one command hook to a settings file, after dropping every earlier one
 * `replaces` recognises, so installing twice leaves one entry. Entries it does
 * not recognise are kept as they are.
 */
export function addEntry(file: string, { event = 'PreToolUse', matcher, command, timeout, statusMessage, replaces }: EntryOptions): void {
  const settings = readSettings(file)
  const hooks = settings.hooks ?? {}
  const kept = withoutOwn(hooks[event], replaces)
  kept.push({
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: 'command', command, ...(timeout === undefined ? {} : { timeout }), ...(statusMessage === undefined ? {} : { statusMessage }) }],
  })
  settings.hooks = { ...hooks, [event]: kept }
  writeSettings(file, settings)
}

/** Drops every command `replaces` recognises, in every event, and an event left empty. */
export function removeEntries(file: string, replaces: (command: string) => boolean): void {
  const settings = readSettings(file)
  if (!settings.hooks)
    return
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = withoutOwn(groups, replaces)
    if (JSON.stringify(kept) === JSON.stringify(groups ?? []))
      continue
    if (kept.length === 0)
      delete settings.hooks[event]
    else
      settings.hooks[event] = kept
  }
  writeSettings(file, settings)
}
