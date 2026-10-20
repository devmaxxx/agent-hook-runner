# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `adopt <claude|codex>`: moves every plain `node <script>` hook onto a stable copy run by the launcher, with a fail mode per event and a backup of the settings file.
- A POSIX `sh` launcher that picks a fitting Node.js from a private download, PATH, nvm, fnm, volta, mise, asdf, n or Homebrew, and remembers it.
- `node install [major]`: a checksum-verified Node.js from nodejs.org that launchers prefer.
- `installHook` / `uninstallHook` for hook authors, plus `copyHook`, `hookCommand`, `adopt`, `parseNodeCommand` and `installNode`.

[Unreleased]: https://github.com/devmaxxx/agent-hook-runner/commits/main
