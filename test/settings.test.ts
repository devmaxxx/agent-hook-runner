import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adopt, installHook, launcherOf, parseNodeCommand, uninstallHook } from '../src'
import { fakeNode, sh, temp, writeHook } from './support'

const read = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))

describe('parseNodeCommand', () => {
  it('reads the script, arguments and a trailing || exit 2', () => {
    expect(parseNodeCommand(`node '/a/it'\\''s/cli.mjs' hook || exit 2`)).toEqual({ script: `/a/it's/cli.mjs`, args: ['hook'], strict: true })
    expect(parseNodeCommand(`/usr/local/bin/node "/a b/x.cjs" pre 'two words'`)).toEqual({ script: '/a b/x.cjs', args: ['pre', 'two words'], strict: false })
    expect(parseNodeCommand('node /a/x.js')).toEqual({ script: '/a/x.js', args: [], strict: false })
  })

  it('leaves alone what it cannot read the way the shell would', () => {
    for (const command of ['node /a/x.js\n/usr/bin/notify', 'node /a/x.js # note', 'node x.js', 'node "$HOME/x.js"', 'node ${CLAUDE_PLUGIN_ROOT}/x.js', 'node /a/x.js | tee log', 'bash /a/x.sh', 'node /a/x.js; rm -rf /', 'node ~/x.js', 'node -e 1'])
      expect(typeof parseNodeCommand(command), command).toBe('string')
  })
})

describe('adopt', () => {
  function settingsWith(home: string, hooks: Record<string, unknown>): string {
    const file = join(home, '.claude/settings.json')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(file, JSON.stringify({ model: 'x', hooks }))
    return file
  }

  it('moves node hooks onto copies with a fail mode per event, keeps the rest, and backs the file up', () => {
    const home = temp()
    const root = join(home, '.agent-hook-runner')
    const guard = writeHook(join(home, 'secrets'), 'cli.mjs')
    const helper = writeHook(join(home, 'nexus'), 'nexus-hook.mjs')
    const file = settingsWith(home, {
      PreToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'bash /x.sh', timeout: 10 }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: `node '${guard}' hook || exit 2`, timeout: 10, statusMessage: 'Scanning' }] },
        { matcher: 'Grep', hooks: [{ type: 'command', command: `node '${helper}' pre` }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: `node '${helper}' stop` }] }],
      SessionStart: null,
    })
    const results = adopt({ agent: 'claude', file, root })
    expect(results.map(r => [r.event, r.adopted ? 'adopted' : r.skipped])).toEqual([
      ['PreToolUse', 'not a plain `node <absolute script> [args]` command'],
      ['PreToolUse', 'adopted'],
      ['PreToolUse', 'adopted'],
      ['Stop', 'adopted'],
    ])
    const written = read(file)
    expect(written.model).toBe('x')
    expect(written.hooks.SessionStart).toBeNull()
    expect(written.hooks.PreToolUse[1].hooks[0]).toMatchObject({ timeout: 10, statusMessage: 'Scanning' })
    const [secrets, pre] = [written.hooks.PreToolUse[1].hooks[0].command, written.hooks.PreToolUse[2].hooks[0].command]
    expect(secrets).toContain(` strict 18 'cli.mjs' 'hook'`)
    expect(pre).toContain(` closed 18 'nexus-hook.mjs' 'pre'`)
    expect(written.hooks.Stop[0].hooks[0].command).toContain(` open 18 'nexus-hook.mjs' 'stop'`)
    expect(launcherOf(pre)).toBe(launcherOf(written.hooks.Stop[0].hooks[0].command))
    expect(readdirSync(join(home, '.claude')).filter(name => name.startsWith('settings.json.bak-'))).toHaveLength(1)

    const pathBin = join(home, 'bin')
    fakeNode(pathBin, 'v22.13.1')
    const run = sh(pre, { HOME: home, PATH: `${pathBin}:/usr/bin:/bin` }, '{"x":1}')
    expect(JSON.parse(run.stdout)).toMatchObject({ args: ['pre'], input: '{"x":1}', tag: 'helper' })

    expect(adopt({ agent: 'claude', file, root }).filter(r => r.adopted)).toHaveLength(0)
  })

  it('reads the hook\'s minimum Node.js from its package and honours overrides', () => {
    const home = temp()
    const script = writeHook(join(home, 'pkg/dist'))
    writeFileSync(join(home, 'pkg/package.json'), JSON.stringify({ name: '@scope/my hook', engines: { node: '>=20.11' } }))
    const file = settingsWith(home, { PreToolUse: [{ hooks: [{ type: 'command', command: `node ${script}` }] }] })
    const root = join(home, 'r')
    expect(adopt({ agent: 'claude', file, root, dryRun: true })[0]!.adopted).toBe('my-hook: closed, Node.js 20+')
    expect(read(file).hooks.PreToolUse[0].hooks[0].command).toBe(`node ${script}`)
    adopt({ agent: 'claude', file, root, fail: 'open', minNode: 24 })
    expect(adopt({ agent: 'claude', file, root, only: 'elsewhere' })).toEqual([])
    adopt({ agent: 'claude', file, root, fail: 'open', minNode: 24, only: 'pkg/dist' })
    expect(read(file).hooks.PreToolUse[0].hooks[0].command).toMatch(/^\[ -x '.+\/r\/my-hook\/[0-9a-f]{12}\/run\.sh' \] && exec '.+' open 24 'hook\.mjs'$/)
  })

  it('skips a hook it cannot copy whole, adopts the rest, and keeps a linked settings file linked', () => {
    const home = temp()
    const kept = writeHook(join(home, 'needs-modules'))
    mkdirSync(join(home, 'needs-modules/node_modules'))
    const named = writeHook(join(home, 'plain'), 'node.js')
    writeFileSync(join(home, 'plain/package.json'), JSON.stringify({ type: 'module' }))
    const typed = join(home, 'pkg/dist/hook.js')
    mkdirSync(join(home, 'pkg/dist'), { recursive: true })
    writeFileSync(join(home, 'pkg/package.json'), JSON.stringify({ name: 'typed', type: 'module' }))
    writeFileSync(typed, 'export {}\nprocess.stdout.write(\'esm\')\n')
    const real = join(home, 'dotfiles/settings.json')
    mkdirSync(join(home, 'dotfiles'))
    writeFileSync(real, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [
      null,
      { type: 'command', command: `node ${kept}` },
      { type: 'command', command: `node ${named}` },
      { type: 'command', command: `node ${typed}` },
    ] }] } }))
    mkdirSync(join(home, '.claude'))
    const file = join(home, '.claude/settings.json')
    symlinkSync(real, file)
    const root = join(home, 'r')
    const results = adopt({ agent: 'claude', file, root })
    expect(results.map(r => r.skipped ?? 'adopted')).toEqual([expect.stringContaining('node_modules would have to come along'), 'adopted', 'adopted'])
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    const commands = read(real).hooks.PreToolUse[0].hooks.slice(1).map((h: any) => h.command)
    expect(commands[0]).toBe(`node ${kept}`)
    expect(commands[1]).toContain(`${root}/node-hook/`)
    expect(commands[2]).toContain(`${root}/typed/`)
    const pathBin = join(home, 'bin')
    fakeNode(pathBin, 'v22.13.1')
    expect(sh(commands[2], { HOME: home, PATH: `${pathBin}:/usr/bin:/bin` }).stdout).toBe('esm')
  })

  it('refuses a file it cannot rewrite and leaves it unchanged', () => {
    for (const text of ['{', '[]', '{"hooks": []}', '{"hooks": {"Stop": {}}}']) {
      const home = temp()
      mkdirSync(join(home, '.claude'))
      const file = join(home, '.claude/settings.json')
      writeFileSync(file, text)
      expect(() => adopt({ agent: 'claude', file, root: join(home, 'r') }), text).toThrow(file)
      expect(readFileSync(file, 'utf8')).toBe(text)
    }
  })
})

describe('installHook', () => {
  it('installs once, replaces an older command, keeps other hooks and uninstalls', () => {
    const home = temp()
    const root = join(home, 'r')
    const file = join(home, 'settings.json')
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [
      { matcher: '*', hooks: [{ type: 'command', command: 'other' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: `node '/old/cli.mjs' hook || exit 2` }] },
    ] } }))
    const entry = writeHook(join(home, 'dist'), 'cli.mjs')
    const options = { agent: 'claude', name: 'secrets', entry, file, root, matcher: 'Bash', args: ['hook'], fail: 'strict', timeout: 10, replaces: (c: string) => c.startsWith('node \'/old/') } as const
    installHook(options)
    installHook(options)
    const hooks = read(file).hooks.PreToolUse
    expect(hooks).toHaveLength(2)
    expect(hooks[1]).toMatchObject({ matcher: 'Bash', hooks: [{ type: 'command', timeout: 10 }] })
    expect(hooks[1].hooks[0].command).toContain(`${root}/secrets/`)
    uninstallHook({ agent: 'claude', name: 'secrets', file, root })
    expect(read(file).hooks.PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: 'other' }] }])
  })
})
