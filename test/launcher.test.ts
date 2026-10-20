import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyHook, hookCommand } from '../src'
import { fakeNode, sh, temp, writeHook } from './support'

function setup(dirName = 'hooks') {
  const home = temp()
  const root = join(home, '.agent-hook-runner')
  const hook = copyHook({ name: 'demo', entry: writeHook(join(home, dirName)), root })
  const pathBin = join(home, 'path-bin')
  return { home, root, hook, pathBin, env: (extra: Record<string, string> = {}) => ({ HOME: home, PATH: `${pathBin}:/usr/bin:/bin`, ...extra }) }
}

const ran = (stdout: string): { node: string | null, args: string[], input: string, tag: string } => JSON.parse(stdout)

describe('launcher', () => {
  it('passes over an old node on PATH for the newest nvm version that fits, and remembers it', () => {
    const { home, hook, pathBin, env } = setup()
    fakeNode(pathBin, 'v18.20.6')
    fakeNode(join(home, '.nvm/versions/node/v20.20.2/bin'), 'v20.20.2')
    const v24 = fakeNode(join(home, '.nvm/versions/node/v24.16.0/bin'), 'v24.16.0')
    fakeNode(join(home, '.nvm/versions/node/v9.11.2/bin'), 'v9.11.2')
    const run = sh(hookCommand(hook, { minNode: 22, args: ['pre', 'it\'s $HOME'] }), env(), '{"tool_name":"Bash"}')
    expect(run.status, run.stderr).toBe(0)
    expect(ran(run.stdout)).toEqual({ node: 'v24.16.0', args: ['pre', 'it\'s $HOME'], input: '{"tool_name":"Bash"}', tag: 'helper' })
    expect(readFileSync(join(hook.dir, 'node-path-22'), 'utf8').trim()).toBe(v24)
  })

  it('keeps a node on PATH that fits, and looks again once the remembered one is gone', () => {
    const { home, hook, pathBin, env } = setup()
    const onPath = fakeNode(pathBin, 'v22.13.1')
    fakeNode(join(home, '.nvm/versions/node/v24.16.0/bin'), 'v24.16.0')
    expect(ran(sh(hookCommand(hook), env()).stdout).node).toBe('v22.13.1')
    rmSync(onPath)
    expect(ran(sh(hookCommand(hook), env()).stdout).node).toBe('v24.16.0')
    expect(readFileSync(join(hook.dir, 'node-path-22'), 'utf8')).toContain('.nvm/versions/node/v24.16.0')
  })

  it('prefers a Node.js it downloaded over everything else', () => {
    const { root, hook, pathBin, env } = setup()
    fakeNode(pathBin, 'v24.16.0')
    fakeNode(join(root, 'node/v22.23.3/bin'), 'v22.23.3')
    expect(ran(sh(hookCommand(hook), env()).stdout).node).toBe('v22.23.3')
  })

  it('reads fnm, volta, mise, asdf and n layouts', () => {
    for (const layout of ['.local/share/fnm/node-versions/v23.6.0/installation/bin', 'Library/Application Support/fnm/node-versions/v23.6.0/installation/bin', '.volta/tools/image/node/23.6.0/bin', '.local/share/mise/installs/node/23.6.0/bin', '.asdf/installs/nodejs/23.6.0/bin']) {
      const { home, hook, env } = setup()
      fakeNode(join(home, layout), 'v23.6.0')
      expect(ran(sh(hookCommand(hook, { minNode: 23 }), env()).stdout).node, layout).toBe('v23.6.0')
    }
    const { home, hook, env } = setup()
    fakeNode(join(home, 'n/n/versions/node/23.6.0/bin'), 'v23.6.0')
    expect(ran(sh(hookCommand(hook, { minNode: 23 }), env({ N_PREFIX: join(home, 'n') })).stdout).node).toBe('v23.6.0')
  })

  it('takes the newest patch of a line, not the first directory name', () => {
    const { home, hook, env } = setup()
    for (const version of ['22.12.0', '22.13.1', '22.9.0', '22.2.0'])
      fakeNode(join(home, `.nvm/versions/node/v${version}/bin`), `v${version}`)
    expect(ran(sh(hookCommand(hook), env()).stdout).node).toBe('v22.13.1')
  })

  it('remembers a node per minimum version, so a lower one never satisfies a higher', () => {
    const { home, hook, pathBin, env } = setup()
    fakeNode(pathBin, 'v18.20.6')
    fakeNode(join(home, '.nvm/versions/node/v22.13.1/bin'), 'v22.13.1')
    expect(ran(sh(hookCommand(hook, { minNode: 18 }), env()).stdout).node).toBe('v18.20.6')
    expect(ran(sh(hookCommand(hook, { minNode: 22 }), env()).stdout).node).toBe('v22.13.1')
    expect(ran(sh(hookCommand(hook, { minNode: 18 }), env()).stdout).node).toBe('v18.20.6')
  })

  it('blocks or lets the call go on, by fail mode, when no node fits', () => {
    const { hook, pathBin, env } = setup()
    fakeNode(pathBin, 'v18.20.6')
    for (const [fail, status] of [['open', 1], ['closed', 2], ['strict', 2]] as const) {
      const run = sh(hookCommand(hook, { fail, minNode: 999 }), env())
      expect(run.status, fail).toBe(status)
      expect(run.stderr).toContain('no Node.js 999 or later found for hook.mjs (node on PATH: v18.20.6)')
    }
    expect(existsSync(join(hook.dir, 'node-path-999'))).toBe(false)
  })

  it('hands the hook\'s exit back, and in strict mode turns a failure into 2', () => {
    const { hook, pathBin, env } = setup()
    fakeNode(pathBin, 'v24.16.0')
    for (const [fail, exit, status] of [['closed', '1', 1], ['closed', '2', 2], ['open', '1', 1], ['strict', '1', 2], ['strict', '0', 0]] as const)
      expect(sh(hookCommand(hook, { fail }), env({ EXIT: exit })).status, `${fail} ${exit}`).toBe(status)
  })

  it('blocks on a missing copy unless the hook is open', () => {
    const { hook, pathBin, env } = setup('it\'s $dir')
    fakeNode(pathBin, 'v24.16.0')
    expect(sh(hookCommand(hook), env()).status).toBe(0)
    rmSync(join(hook.dir, 'hook', hook.entry))
    expect(sh(hookCommand(hook), env()).status).toBe(2)
    rmSync(hook.dir, { recursive: true })
    expect(sh(hookCommand(hook, { fail: 'closed' }), env()).status).toBe(2)
    expect(sh(hookCommand(hook, { fail: 'strict' }), env()).status).toBe(2)
    expect(sh(hookCommand(hook, { fail: 'open' }), env()).status).toBe(1)
  })
})
