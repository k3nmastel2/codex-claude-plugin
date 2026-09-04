# Changelog

## 0.1.0 — 2026-09-04

- Initial release.
- Skills for Codex: `claude-task`, `claude-review`, `claude-setup`, `claude-jobs`.
- Companion CLI `claude-companion.mjs` drives `claude -p --output-format json` with the prompt on stdin.
- Permission levels: read-only by default, `--write` (accept edits), `--full` (skip all permission checks), plus `--allow <rule>`.
- Session continuity with `--resume` / `--fresh` per repository.
- Structured reviews (`--adversarial`, `--base`, `--scope`) using a JSON schema, rendered by severity.
- Background jobs with `status`, `result`, and `cancel`; process-tree termination on macOS, Linux, and Windows.
- Loop guard: refuses to nest under a Claude Code session or beyond `CLAUDE_COMPANION_MAX_DEPTH`.
- Dependency-free test suite with a fake `claude` binary; CI on ubuntu, macos, and windows.
- Detects Codex's sandbox (`CODEX_SANDBOX_NETWORK_DISABLED=1`) and explains how to escalate instead of reporting a bogus login failure.
- Job and state files are written atomically and the result is stored before the job flips to a terminal status.
- Windows: the npm `claude.cmd` shim is parsed for its real script so nothing passes through `cmd.exe`; repo checkouts are forced to LF.
- Read-only mode uses Claude Code's `--restricted` (2.1.248+): shell and code tools removed, settings files ignored, file tools confined to the workspace; `--allow` switches to `--setting-sources ""` with exactly the given rule.

Verified on macOS 2026-09-04 against Claude Code 2.1.238 and Codex CLI 0.145.0: `setup` reports ready once `claude auth login` has run; `task` delivers the prompt on stdin and returns the answer with a session trailer; `--resume` continues the same Claude session; `--background` jobs complete and `status`/`result` read them back; the nesting guard refuses to run inside a Claude Code session; and `$claude-task` invoked from a real `codex exec` thread returns Claude's answer verbatim.
