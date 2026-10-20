# agent-hook-runner

**Run Claude Code and Codex hooks from a stable copy, on a Node.js that fits. Survives Node upgrades, nvm switches, `npx` cache cleans and rebuilds, with a fail mode per hook. Zero dependencies.**

## Why

A Node.js hook is usually registered as `node '/path/to/hook.mjs'`, and that path is fragile:

- a global package lives under one Node version (`~/.nvm/versions/node/v24.16.0/lib/node_modules/...`), so upgrading or removing that version deletes the hook;
- a hook run from a checkout's `dist/` changes under every running session on each rebuild;
- the `node` on PATH is whatever the agent was started with, so a project pinning Node 18 runs your hooks on Node 18.

When the hook cannot start, the agent sees exit 1 or 127 — which Claude Code treats as "go on". A secret scanner that cannot run stops scanning, silently.

`agent-hook-runner` copies the hook to `~/.agent-hook-runner/<name>/<content hash>/` and runs it through a small POSIX `sh` launcher that finds a fitting `node` itself, and decides per hook what happens when none can be found.

## Install

```sh
npm install -g agent-hook-runner   # or run it with npx
```

The CLI needs Node.js 22 or later. The launcher it writes needs only `sh`.

## Adopt the hooks you already have

```sh
npx agent-hook-runner adopt claude --dry-run   # what would change
npx agent-hook-runner adopt claude             # ~/.claude/settings.json
npx agent-hook-runner adopt codex              # ~/.codex/hooks.json; then trust the hooks in /hooks
npx agent-hook-runner adopt codex --only gitnexus --fail open
```

Every hook whose command is a plain `node <absolute script> [args] [|| exit 2]` is copied — the whole directory holding its script, without dotfiles, so a hook split into chunks or sibling modules keeps working, and with its package's `"type"` so a `.js` file loads the same way — and its command is rewritten to run the copy. Matchers, timeouts and status messages stay. Anything else (`bash` hooks, variables, pipes, several lines, relative paths) and any hook that cannot be copied whole is listed as skipped with the reason. The settings file is backed up beside itself first. Running `adopt` again leaves adopted hooks alone.

Options: `--project` (the working directory's settings), `--fail open|closed|strict`, `--min-node <major>`, `--only <text>` (hooks whose command contains it), `--dry-run`.

## How the launcher finds Node.js

It takes the first that fits the hook's minimum major version and remembers the answer beside itself, separately for each minimum version, so later calls cost one file test (about 14 ms per call in all, against running `node` directly):

1. the `node` it used last time, while that file still exists;
2. a Node.js downloaded with `agent-hook-runner node install`, newest first;
3. `node` on PATH;
4. the newest fitting version installed by nvm, fnm (including its macOS `~/Library/Application Support/fnm`), volta, mise, asdf or n — read from the directory name, without starting it;
5. `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`.

The minimum is the hook package's `engines.node`, else 18, or `--min-node`.

### A private Node.js

```sh
npx agent-hook-runner node install 22
```

Downloads the newest Node.js 22 for this macOS or Linux machine from nodejs.org into `~/.agent-hook-runner/node/`, checks the archive against the release's `SHASUMS256.txt`, and makes every launcher look again. From then on hooks run on it whatever Node.js you switch to. It takes about 190 MB; delete the directory to remove it.

## Fail modes

| Mode | Hook cannot run | Hook exits non-zero |
| --- | --- | --- |
| `open` | exit 1: the agent goes on, the message is shown | passed through |
| `closed` | exit 2: the agent blocks the action, the message is shown | passed through |
| `strict` | exit 2 | exit 2, as `node hook.js \|\| exit 2` did |

`adopt` picks `strict` for a command that ended in `|| exit 2`, `closed` on `PreToolUse`, `UserPromptSubmit` and `PermissionRequest`, and `open` elsewhere — exit 2 on `Stop` would keep the agent from stopping.

## For hook authors

Let your CLI's `install` command register itself through the launcher:

```ts
import { fileURLToPath } from 'node:url'
import { installHook, uninstallHook } from 'agent-hook-runner'

installHook({
  agent: 'claude',
  name: 'my-hook',
  entry: fileURLToPath(import.meta.url),
  args: ['hook'],
  matcher: 'Bash|Write|Edit',
  fail: 'strict',
  minNode: 22,
  timeout: 10,
  replaces: command => command.includes('/my-hook/dist/cli.mjs'), // entries older versions wrote
})
uninstallHook({ agent: 'claude', name: 'my-hook' })
```

The launcher is a string constant, so the library can be bundled into a zero-dependency CLI. Lower-level pieces: `copyHook`, `hookCommand`, `adopt`, `parseNodeCommand`, `installNode`, `readSettings`, `settingsFile`.

## Limits

- POSIX only: the launcher is `sh`. Windows is not supported.
- A hook that needs `node_modules` or a symbolic link must be bundled into one directory first; a directory over 16 MiB is refused. Everything in the script's directory except dotfiles is copied, so keep a hook in a directory of its own.
- Old copies stay in `~/.agent-hook-runner` after an upgrade or `uninstallHook`, since another agent's entry may still run one. They are small and safe to delete.
- Codex marks a changed hook command for review: trust it once in `/hooks` after `adopt`.

## License

MIT
