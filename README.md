# codex-claude-plugin

Use Claude Code from inside OpenAI Codex, the mirror image of the official `codex` plugin for Claude Code.

Codex gets four skills: `$claude-task` delegates a task or investigation, `$claude-review` asks for a structured code review, `$claude-jobs` manages background jobs, and `$claude-setup` checks the install. They drive the `claude` CLI you already have; nothing here talks to an API directly and no API key is needed.

## Requirements

- Node.js 20 or newer
- Codex CLI 0.145 or newer (or the Codex desktop app)
- Claude Code CLI installed and logged in: run `claude auth login` once in your own terminal. An `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the environment also works.

## Install

```bash
codex plugin marketplace add k3nmastel2/codex-claude-plugin
codex plugin add claude@codex-claude-plugin
```

From a local clone instead:

```bash
codex plugin marketplace add /path/to/codex-claude-plugin
codex plugin add claude@codex-claude-plugin
```

Start a new Codex thread, then run `$claude-setup`. It tells you if anything is missing.

## Use

| Say to Codex | What happens |
|---|---|
| `$claude-task explain how sessions are refreshed` | Claude reads the repo and answers. Read-only. |
| `$claude-task --write fix the null check in auth.ts` | Claude may edit files inside the workspace. |
| `$claude-task --full run the test suite and fix failures` | Claude may edit and run commands. Skips all permission checks. |
| `$claude-task --resume apply the top fix` | Continues the last Claude thread for this repo. |
| `$claude-task --background port the parser to TypeScript` | Returns a job id immediately. |
| `$claude-review` | Structured review of the dirty working tree, or the branch vs its base. |
| `$claude-review --adversarial --base main focus on migrations` | Adversarial review with a focus. |
| `$claude-jobs status` / `result` / `cancel` | Background job management. |

Permission levels map onto Claude Code flags: read-only uses `--permission-mode dontAsk` with edit tools disallowed, `--write` uses `--permission-mode acceptEdits`, `--full` uses `--dangerously-skip-permissions`. `--allow "<rule>"` adds `--allowedTools` entries, for example `--allow "Bash(npm test:*)"`. `--model` and `--effort` pass through unchanged.

## How it works

`plugins/claude/scripts/claude-companion.mjs` runs `claude -p --output-format json`, feeds the prompt on stdin, parses the JSON result, and prints Claude's final message followed by a one-line trailer with the session id, turn count, and cost. Reviews add `--json-schema` so findings come back structured and are printed ordered by severity.

Per-repository state (last session id, job records, logs) lives under `$CODEX_HOME/claude-companion/state/` (default `~/.codex/claude-companion/state/`). Background jobs run in a detached worker; `status`, `result`, and `cancel` read the job files.

Loop guard: Claude's own `codex` plugin can call Codex, which could call this plugin, which would call Claude again. The companion refuses to run when `CLAUDE_COMPANION_DEPTH` reaches `CLAUDE_COMPANION_MAX_DEPTH` (default 1) or when it inherits `CLAUDECODE=1`, and it appends a system prompt telling Claude not to delegate back. Pass `--allow-nested` to override.

Claude runs with your own Claude Code credentials, settings, plugins, and billing. `--full` disables every permission check; use it only in repositories you trust.

## Companion CLI

```
node plugins/claude/scripts/claude-companion.mjs setup [--json]
node plugins/claude/scripts/claude-companion.mjs task [--write|--full] [--allow <rule>]... [--resume|--fresh] [--model <m>] [--effort <e>] [--max-turns <n>] [--max-budget-usd <x>] [--add-dir <d>]... [--timeout-ms <n>] [--background] [--json] [--] <prompt|->
node plugins/claude/scripts/claude-companion.mjs review [--adversarial] [--base <ref>] [--scope auto|working-tree|branch] [--timeout-ms <n>] [--background] [--json] [focus...]
node plugins/claude/scripts/claude-companion.mjs status [job-id] [--all] [--json]
node plugins/claude/scripts/claude-companion.mjs result [job-id] [--json]
node plugins/claude/scripts/claude-companion.mjs cancel [job-id] [--json]
node plugins/claude/scripts/claude-companion.mjs resume-candidate --json
```

Environment overrides: `CLAUDE_COMPANION_CLAUDE_CMD` (command used instead of `claude`, used by the tests), `CLAUDE_COMPANION_STATE_DIR`, `CLAUDE_COMPANION_MAX_DEPTH`, `CLAUDE_COMPANION_PROMPT_VIA_ARGV=1` (pass the prompt as an argument instead of stdin).

## Windows

Everything is Node with no shell dependencies. The companion resolves `claude.exe` or unwraps the npm `claude.cmd` shim so long prompts never pass through `cmd.exe`. Background jobs are cancelled with `taskkill /T`.

## Development

```bash
npm test
```

Tests use a fake `claude` binary in `tests/fixtures/`, so they run without credentials or spend. After editing the plugin, bump the version suffix in `plugins/claude/.codex-plugin/plugin.json` (for example `0.1.0+codex.20260904T170000`) and re-run `codex plugin add claude@codex-claude-plugin` so Codex reloads it; then start a new thread.

## License

MIT
