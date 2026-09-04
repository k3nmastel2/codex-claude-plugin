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
