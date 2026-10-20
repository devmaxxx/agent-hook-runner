import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { defaultRoot } from './copy'

export interface NodeInstallOptions {
  /** The major version line; the newest release of it is installed. Defaults to 22. */
  major?: number
  /** Defaults to `~/.agent-hook-runner`. */
  root?: string
  /** Defaults to `https://nodejs.org/dist`. */
  dist?: string
  platform?: string
  arch?: string
}

const PLATFORMS: Record<string, string> = { darwin: 'darwin', linux: 'linux' }
const ARCHES: Record<string, string> = { arm64: 'arm64', x64: 'x64' }

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`GET ${url} answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Downloads the newest Node.js of a major line from nodejs.org into
 * `<root>/node/v<version>/`, after checking the archive against the release's
 * SHASUMS256.txt, and returns its `node`. Launchers prefer it to any other
 * Node.js, so hooks stop depending on the one the user switches between.
 */
export async function installNode({ major = 22, root = defaultRoot(), dist = 'https://nodejs.org/dist', platform = process.platform, arch = process.arch }: NodeInstallOptions = {}): Promise<string> {
  const os = PLATFORMS[platform]
  const cpu = ARCHES[arch]
  if (!os || !cpu)
    throw new Error(`no Node.js download for ${platform}-${arch}; install one with your package manager`)
  const line = `${dist}/latest-v${major}.x`
  const sums = new TextDecoder().decode(await download(`${line}/SHASUMS256.txt`))
  const match = new RegExp(String.raw`^([0-9a-f]{64})\s+(node-v(\d+\.\d+\.\d+)-${os}-${cpu}\.tar\.gz)$`, 'm').exec(sums)
  if (!match)
    throw new Error(`${line}/SHASUMS256.txt lists no ${os}-${cpu} archive`)
  const [, sum, archive, version] = match as unknown as [string, string, string, string]
  const target = join(root, 'node', `v${version}`)
  const node = join(target, 'bin', 'node')
  if (existsSync(node))
    return node
  const bytes = await download(`${line}/${archive}`)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== sum)
    throw new Error(`${archive} has sha256 ${actual}, but SHASUMS256.txt says ${sum}; nothing was installed`)
  mkdirSync(join(root, 'node'), { recursive: true })
  const staging = mkdtempSync(`${target}-`)
  try {
    writeFileSync(join(staging, archive), bytes)
    const tar = spawnSync('tar', ['-xzf', archive, '--strip-components', '1'], { cwd: staging, encoding: 'utf8' })
    if (tar.status !== 0)
      throw new Error(`tar could not unpack ${archive}: ${tar.stderr.trim()}`)
    rmSync(join(staging, archive))
    if (!existsSync(join(staging, 'bin', 'node')))
      throw new Error(`${archive} holds no bin/node`)
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  }
  finally {
    rmSync(staging, { recursive: true, force: true })
  }
  forgetResolvedNode(root)
  return node
}

/**
 * Drops every launcher's remembered `node`, so each looks again on its next
 * call and finds a Node.js that was just installed.
 */
export function forgetResolvedNode(root = defaultRoot()): void {
  if (!existsSync(root))
    return
  for (const name of readdirSync(root)) {
    if (name === 'node' || !lstatSync(join(root, name)).isDirectory())
      continue
    for (const id of readdirSync(join(root, name))) {
      const dir = join(root, name, id)
      if (lstatSync(dir).isDirectory()) {
        for (const file of readdirSync(dir).filter(file => file.startsWith('node-path-')))
          rmSync(join(dir, file), { force: true })
      }
    }
  }
}
