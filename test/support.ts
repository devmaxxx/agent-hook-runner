import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export const temp = (prefix = 'ahr-'): string => mkdtempSync(join(tmpdir(), prefix))

/**
 * A `node` that reports `version` to `--version` and runs the real Node.js
 * otherwise, so the launcher's choice is visible without installing anything.
 */
export function fakeNode(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'node')
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = --version ] && { echo ${version}; exit 0; }\nFAKE_NODE=${version} exec '${process.execPath}' "$@"\n`)
  chmodSync(bin, 0o755)
  return bin
}

/** A hook that prints which fake node ran it, its arguments and its stdin, and exits with `EXIT`. */
export function writeHook(dir: string, name = 'hook.mjs'): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'helper.mjs'), 'export const tag = \'helper\'\n')
  writeFileSync(join(dir, name), [
    'import { readFileSync } from \'node:fs\'',
    'import { tag } from \'./helper.mjs\'',
    'const input = readFileSync(0, \'utf8\')',
    'process.stdout.write(JSON.stringify({ node: process.env.FAKE_NODE ?? null, args: process.argv.slice(2), input, tag }))',
    'process.exitCode = Number(process.env.EXIT ?? 0)',
  ].join('\n'))
  return join(dir, name)
}

export interface Run { status: number | null, stdout: string, stderr: string }

/** Runs a hook command the way the agents do: `sh -c`, the tool call on stdin. */
export function sh(command: string, env: Record<string, string>, input = '{}'): Run {
  const result = spawnSync('sh', ['-c', command], { input, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
