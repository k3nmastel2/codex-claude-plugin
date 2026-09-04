# Security policy

This plugin runs Claude Code on your machine with your own credentials. The things worth attacking are the permission boundary (`read` → `--write` → `--full`), the loop guard, and anything that could make the companion run a command it was not asked to run.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

https://github.com/k3nmastel2/codex-claude-plugin/security/advisories/new

Include the version (`codex plugin list`), your OS, and a minimal reproduction. You will get an acknowledgement within a few days. Please do not open a public issue until a fix is available.

## Scope notes

- Prompts are passed to Claude on stdin, never through a shell, and never logged by this plugin beyond the job files under `$CODEX_HOME/claude-companion/state/`, which stay on your machine.
- `--full` disables every Claude Code permission check by design. That is a feature, documented as such, not a vulnerability.
- Claude Code itself, Codex itself, and the models are out of scope; report those to Anthropic and OpenAI respectively.
