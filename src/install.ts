import type { CommandOptions } from './command'
import type { Agent } from './settings'
import { sep } from 'node:path'
import { hookCommand, launcherOf } from './command'
import { copyHook, defaultRoot } from './copy'
import { addEntry, removeEntries, settingsFile } from './settings'

export interface InstallOptions extends CommandOptions {
  agent: Agent
  /** A short name for the hook; its copies live under `<root>/<name>/`. */
  name: string
  /** The hook's entry script, usually `fileURLToPath(import.meta.url)` of a CLI. */
  entry: string
  /** Defaults to `PreToolUse`. */
  event?: string
  matcher?: string
  timeout?: number
  statusMessage?: string
  /** Defaults to the agent's user settings file. */
  file?: string
  /** Defaults to `~/.agent-hook-runner`. */
  root?: string
  /** Commands an older version of the hook wrote, so they are replaced too. */
  replaces?: (command: string) => boolean
}

function ownedBy(name: string, root: string, replaces?: (command: string) => boolean) {
  return (command: string): boolean =>
    launcherOf(command)?.startsWith(`${root}${sep}${name}${sep}`) === true || replaces?.(command) === true
}

/**
 * Copies a hook, writes the entry that runs it through the launcher and drops
 * the entries of earlier installs. Returns the settings file it wrote.
 */
export function installHook(options: InstallOptions): string {
  const { agent, name, entry, event, matcher, timeout, statusMessage, root = defaultRoot(), file = settingsFile(agent), replaces } = options
  const command = hookCommand(copyHook({ name, entry, root }), options)
  addEntry(file, { event, matcher, command, timeout, statusMessage, replaces: ownedBy(name, root, replaces) })
  return file
}

export interface UninstallOptions {
  agent: Agent
  name: string
  file?: string
  root?: string
  replaces?: (command: string) => boolean
}

/**
 * Removes the hook's entries. Its copies stay, since another agent's entry may
 * still run one; they are small and safe to delete by hand.
 */
export function uninstallHook({ agent, name, root = defaultRoot(), file = settingsFile(agent), replaces }: UninstallOptions): string {
  removeEntries(file, ownedBy(name, root, replaces))
  return file
}
