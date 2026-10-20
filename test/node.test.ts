import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { copyHook, installNode } from '../src'
import { fakeNode, temp, writeHook } from './support'

// A nodejs.org dist tree with one release line, served from memory.
const files = new Map<string, Buffer>()
const server = createServer((request, response) => {
  const body = files.get(request.url ?? '')
  response.writeHead(body ? 200 : 404).end(body)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const dist = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dist`
afterAll(() => server.close())

function publish(version: string, tamper = false): void {
  const work = temp()
  const name = `node-v${version}-linux-x64`
  fakeNode(join(work, name, 'bin'), `v${version}`)
  execFileSync('tar', ['-czf', `${name}.tar.gz`, name], { cwd: work })
  const archive = readFileSync(join(work, `${name}.tar.gz`))
  const sum = createHash('sha256').update(tamper ? Buffer.from('other') : archive).digest('hex')
  const line = `/dist/latest-v${version.split('.')[0]}.x`
  files.set(`${line}/${name}.tar.gz`, archive)
  files.set(`${line}/SHASUMS256.txt`, Buffer.from(`${'0'.repeat(64)}  node-v${version}-darwin-arm64.tar.gz\n${sum}  ${name}.tar.gz\n`))
}

describe('installNode', () => {
  it('installs the checked archive and makes launchers look again', async () => {
    publish('22.23.3')
    const root = join(temp(), 'r')
    const hook = copyHook({ name: 'demo', entry: writeHook(join(root, '..', 'h')), root })
    mkdirSync(hook.dir, { recursive: true })
    writeFileSync(join(hook.dir, 'node-path-22'), '/old/node\n')
    const node = await installNode({ major: 22, root, dist, platform: 'linux', arch: 'x64' })
    expect(node).toBe(join(root, 'node/v22.23.3/bin/node'))
    expect(execFileSync(node, ['--version'], { encoding: 'utf8' }).trim()).toBe('v22.23.3')
    expect(existsSync(join(hook.dir, 'node-path-22'))).toBe(false)
    expect(await installNode({ major: 22, root, dist, platform: 'linux', arch: 'x64' })).toBe(node)
  })

  it('installs nothing when the archive does not match its checksum', async () => {
    publish('24.16.0', true)
    const root = join(temp(), 'r')
    await expect(installNode({ major: 24, root, dist, platform: 'linux', arch: 'x64' })).rejects.toThrow('nothing was installed')
    expect(existsSync(join(root, 'node/v24.16.0'))).toBe(false)
  })

  it('refuses a platform nodejs.org has no tarball for', async () => {
    await expect(installNode({ root: temp(), dist, platform: 'win32', arch: 'x64' })).rejects.toThrow('win32-x64')
  })
})
