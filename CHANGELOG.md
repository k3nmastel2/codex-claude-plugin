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

Verified on macOS 2026-09-04 against Claude Code 2.1.238 and Codex CLI 0.145.0: `setup` reports ready once `claude auth login` has run; `task` delivers the prompt on stdin and returns the answer with a session trailer; `--resume` continues the same Claude session; `--background` jobs complete and `status`/`result` read them back; the nesting guard refuses to run inside a Claude Code session; and `$claude-task` invoked from a real `codex exec` thread returns Claude's answer verbatim.
