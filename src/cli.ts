#!/usr/bin/env node
import type { FailMode } from './launcher'
import process from 'node:process'
import { adopt } from './adopt'
import { installNode } from './node'
import { settingsFile } from './settings'

const USAGE = `Usage:
  agent-hook-runner adopt <claude|codex> [--project] [--fail open|closed|strict] [--min-node <major>] [--only <text>] [--dry-run]
      run every plain \`node <script>\` hook from a stable copy on a Node.js that fits
  agent-hook-runner node install [<major>]
      download Node.js <major> (default 22) from nodejs.org for hooks to prefer`

function option(flags: string[], name: string): string | undefined {
  const index = flags.indexOf(name)
  return index === -1 ? undefined : flags[index + 1]
}

async function main(argv: string[]): Promise<number> {
  const [command, target, ...flags] = argv
  if (command === 'adopt' && (target === 'claude' || target === 'codex')) {
    const fail = option(flags, '--fail')
    const minNode = option(flags, '--min-node')
    if ((fail !== undefined && !['open', 'closed', 'strict'].includes(fail)) || (minNode !== undefined && !/^\d+$/.test(minNode))) {
      console.error(USAGE)
      return 1
    }
    const file = settingsFile(target, flags.includes('--project'))
    const dryRun = flags.includes('--dry-run')
    const results = adopt({ agent: target, file, fail: fail as FailMode | undefined, minNode: minNode === undefined ? undefined : Number(minNode), only: option(flags, '--only'), dryRun })
    for (const result of results)
      process.stdout.write(`${result.adopted ? (dryRun ? 'would adopt' : 'adopted') : 'skipped'}  ${result.event}  ${result.command}\n${result.adopted ? `  -> ${result.adopted}` : `  (${result.skipped})`}\n`)
    const adopted = results.filter(result => result.adopted).length
    process.stdout.write(`${adopted} of ${results.length} hooks ${dryRun ? 'would be adopted' : `adopted in ${file}`}\n`)
    if (adopted > 0 && !dryRun && target === 'codex')
      process.stdout.write('Codex runs a changed hook only after you trust it: open /hooks in Codex once.\n')
    return 0
  }
  if (command === 'node' && target === 'install' && (flags[0] === undefined || /^\d+$/.test(flags[0]))) {
    const node = await installNode({ major: flags[0] === undefined ? undefined : Number(flags[0]) })
    process.stdout.write(`Installed ${node}; hooks run through agent-hook-runner use it from their next call.\n`)
    return 0
  }
  console.error(USAGE)
  return 1
}

try {
  process.exitCode = await main(process.argv.slice(2))
}
catch (error) {
  console.error(`agent-hook-runner: ${(error as Error).message}`)
  process.exitCode = 1
}
