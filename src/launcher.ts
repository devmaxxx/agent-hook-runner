/** What a hook's exit means when it cannot run, or (`strict`) when it fails. */
export type FailMode = 'open' | 'closed' | 'strict'

export const LAUNCHER = 'run.sh'

// The launcher is POSIX sh, not JavaScript, because the one thing it cannot
// assume is a usable `node`. It looks for one in this order and remembers the
// answer in `node-path-<min>` beside itself, so a call after the first costs one
// `[ -x ]` test:
//
//   1. the path it found last time, while that file is still there;
//   2. a Node.js `agent-hook-runner node install` downloaded, newest first;
//   3. `node` on PATH, when its major version is high enough;
//   4. the newest high-enough version nvm, fnm, volta, mise, asdf or n
//      installed, read from the directory name without starting it;
//   5. Homebrew's and the system's `node`.
//
// When none fits it prints why and exits 1 (`open`: the agent goes on) or 2
// (`closed`, `strict`: the agent blocks the action). `strict` also turns any
// failing exit of the hook itself into 2, as `node hook.js || exit 2` did.
//
// The text holds no `${`, so String.raw keeps every backslash for sed.
export const LAUNCHER_SOURCE = String.raw`#!/bin/sh
# Written by agent-hook-runner. Runs the hook beside it on a Node.js that fits.
mode=$1 min=$2 entry=$3
shift 3
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname -- "$(dirname -- "$dir")")

fail() {
  printf 'agent-hook-runner: %s\n' "$1" >&2
  [ "$mode" = open ] && exit 1
  exit 2
}

or() {
  if [ -n "$1" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi
}

major_of() {
  "$1" --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p'
}

fits() {
  m=$(major_of "$1") && [ -n "$m" ] && [ "$m" -ge "$min" ]
}

best= best_key=0
consider() {
  for bin in "$@"; do
    [ -x "$bin" ] || continue
    v=$(printf '%s' "$bin" | sed -n 's#.*/v\{0,1\}\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\)/.*#\1 \2 \3#p')
    [ -n "$v" ] || continue
    read -r major minor patch <<EOF
$v
EOF
    key=$((major * 1000000 + minor * 1000 + patch))
    if [ "$major" -ge "$min" ] && [ "$key" -gt "$best_key" ]; then
      best=$bin best_key=$key
    fi
  done
}

cache="$dir/node-path-$min"
cached= node=
if [ -r "$cache" ]; then
  IFS= read -r cached < "$cache"
  [ -n "$cached" ] && [ -x "$cached" ] && node=$cached
fi
if [ -z "$node" ]; then
  consider "$root"/node/v*/bin/node
  node=$best
fi
if [ -z "$node" ] && on_path=$(command -v node 2>/dev/null) && fits "$on_path"; then
  node=$on_path
fi
if [ -z "$node" ]; then
  data=$(or "$XDG_DATA_HOME" "$HOME/.local/share")
  consider \
    "$(or "$NVM_DIR" "$HOME/.nvm")"/versions/node/v*/bin/node \
    "$(or "$FNM_DIR" "$data/fnm")"/node-versions/v*/installation/bin/node \
    "$HOME/Library/Application Support/fnm"/node-versions/v*/installation/bin/node \
    "$HOME"/.fnm/node-versions/v*/installation/bin/node \
    "$(or "$VOLTA_HOME" "$HOME/.volta")"/tools/image/node/*/bin/node \
    "$(or "$MISE_DATA_DIR" "$data/mise")"/installs/node/*/bin/node \
    "$(or "$ASDF_DATA_DIR" "$HOME/.asdf")"/installs/nodejs/*/bin/node \
    "$(or "$N_PREFIX" /usr/local)"/n/versions/node/*/bin/node
  node=$best
fi
if [ -z "$node" ]; then
  for bin in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if fits "$bin"; then node=$bin; break; fi
  done
fi
if [ -z "$node" ]; then
  fail "no Node.js $min or later found for $entry (node on PATH: $(node --version 2>/dev/null || echo none)). Install one, or run: npx agent-hook-runner node install $min"
fi
if [ "$node" != "$cached" ]; then
  { printf '%s\n' "$node" > "$cache.$$" && mv -f "$cache.$$" "$cache"; } 2>/dev/null
fi

[ -f "$dir/hook/$entry" ] || fail "$dir/hook/$entry is missing; adopt or install the hook again"
if [ "$mode" = strict ]; then
  "$node" "$dir/hook/$entry" "$@" || exit 2
  exit 0
fi
exec "$node" "$dir/hook/$entry" "$@"
`
