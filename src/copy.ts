import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { LAUNCHER, LAUNCHER_SOURCE } from './launcher'

/** Where copies and downloaded Node.js builds live unless a caller says otherwise. */
export const defaultRoot = (): string => join(homedir(), '.agent-hook-runner')

// A hook that is more than this is not a bundled script, and copying it on
// every adopt would fill the disk with someone's project.
const MAX_COPY_BYTES = 16 << 20

export interface CopiedHook {
  /** The directory holding the launcher and `hook/`. */
  dir: string
  /** The launcher the hook command runs. */
  launcher: string
  /** The entry's path inside `hook/`. */
  entry: string
}

export interface CopyOptions {
  /** A short name for the hook; copies are kept apart by it. */
  name: string
  /** The hook's entry script. The directory holding it is copied with it. */
  entry: string
  /** Defaults to `~/.agent-hook-runner`. */
  root?: string
}

export interface HookPlan {
  /** The real directory the hook is copied from. */
  source: string
  /** The entry, relative to `source`. */
  entry: string
  /** Every file to copy, relative to `source`. */
  files: string[]
  /** The `"type"` of the package around `source`, which decides how Node.js loads a `.js` file. */
  type?: string
}

function walk(dir: string, prefix: string, files: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    // Dotfiles are an .env, a .git or an editor's state, never part of a hook.
    if (name.startsWith('.'))
      continue
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (name === 'node_modules')
      throw new Error(`${path} would have to come along; bundle the hook into one directory first`)
    if (stat.isSymbolicLink())
      throw new Error(`${path} is a symbolic link, which a copy cannot keep pointing at the same file`)
    if (stat.isDirectory())
      walk(path, join(prefix, name), files)
    else if (stat.isFile())
      files.push(join(prefix, name))
  }
}

function packageType(source: string): string | undefined {
  let dir = source
  for (let depth = 0; depth < 4; depth++) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const type = JSON.parse(readFileSync(manifest, 'utf8'))?.type
        return typeof type === 'string' ? type : undefined
      }
      catch {
        return undefined
      }
    }
    if (dirname(dir) === dir)
      return undefined
    dir = dirname(dir)
  }
  return undefined
}

/**
 * What `copyHook` would copy, or an error saying why the hook cannot be copied
 * whole. The directory holding the entry is copied, not only the entry, because
 * a bundled hook still loads chunks and sibling modules beside it; one that
 * needs a node_modules is refused, since a copy that left part of it behind
 * would break only when the hook runs.
 */
export function planCopy(entry: string): HookPlan {
  if (!existsSync(entry) || !statSync(entry).isFile())
    throw new Error(`${entry} is not a file`)
  const real = realpathSync(entry)
  const source = dirname(real)
  const files: string[] = []
  walk(source, '', files)
  const bytes = files.reduce((sum, file) => sum + statSync(join(source, file)).size, 0)
  if (bytes > MAX_COPY_BYTES)
    throw new Error(`${source} holds ${bytes} bytes; bundle the hook into its own directory first`)
  return { source, entry: basename(real), files, type: files.includes('package.json') ? undefined : packageType(source) }
}

function contentId(plan: HookPlan): string {
  const hash = createHash('sha256').update(LAUNCHER_SOURCE).update('\0').update(plan.type ?? '')
  for (const file of plan.files)
    hash.update('\0').update(file).update('\0').update(readFileSync(join(plan.source, file)))
  return hash.digest('hex').slice(0, 12)
}

/**
 * Copies a hook and the launcher into `<root>/<name>/<content id>/`.
 *
 * The copy outlives the original, so a Node.js upgrade that deletes its global
 * packages, an `npx` cache clean or a rebuild of a checkout leaves the hook
 * running. The directory is named after its content: the same hook reuses it,
 * a changed one gets a new one, and a copy another agent still points at is
 * never overwritten. It is staged and renamed in, so a running hook never loads
 * a half-written copy, and one whose content no longer matches is copied again.
 */
export function copyHook({ name, entry, root = defaultRoot() }: CopyOptions): CopiedHook {
  // `<root>/node` holds the Node.js builds `installNode` downloads.
  if (!/^[\w.-]+$/.test(name) || name === 'node' || name.startsWith('.'))
    throw new Error(`hook name "${name}" must be letters, digits, ".", "_" and "-", not start with ".", and not be "node"`)
  const plan = planCopy(entry)
  const dir = join(root, name, contentId(plan))
  const matches = (): boolean => {
    try {
      return readFileSync(join(dir, LAUNCHER), 'utf8') === LAUNCHER_SOURCE
        && plan.files.every(file => readFileSync(join(dir, 'hook', file)).equals(readFileSync(join(plan.source, file))))
    }
    catch {
      return false
    }
  }
  if (!matches()) {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 })
    const staging = mkdtempSync(`${dir}-`)
    try {
      for (const file of plan.files) {
        mkdirSync(dirname(join(staging, 'hook', file)), { recursive: true })
        copyFileSync(join(plan.source, file), join(staging, 'hook', file))
      }
      if (plan.type)
        writeFileSync(join(staging, 'hook', 'package.json'), `${JSON.stringify({ type: plan.type })}\n`)
      writeFileSync(join(staging, LAUNCHER), LAUNCHER_SOURCE)
      chmodSync(join(staging, LAUNCHER), 0o755)
      rmSync(dir, { recursive: true, force: true })
      renameSync(staging, dir)
    }
    catch (error) {
      // Another install of the same hook got there first.
      if (!matches())
        throw error
    }
    finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  return { dir, launcher: join(dir, LAUNCHER), entry: plan.entry }
}
