# Contributing

Thanks for helping make Codex and Claude Code work together. This is a small, dependency-free Node project, so getting started takes a minute.

## Set up

```bash
git clone https://github.com/k3nmastel2/codex-claude-plugin
cd codex-claude-plugin
npm test
```

`npm test` runs every test with a fake `claude` binary (`tests/fixtures/fake-claude.mjs`). It needs no credentials and spends nothing. Node 20 or newer and git are the only requirements.

To try your change inside Codex, add your clone as a marketplace once, then refresh the installed copy after each edit:

```bash
codex plugin marketplace add /path/to/codex-claude-plugin   # once
codex plugin add claude@codex-claude-plugin                    # after every edit; refreshes the cached copy
```

On Codex 0.145 `codex plugin add` refreshes the cached copy; if Codex still shows the old files, run `codex plugin remove claude` and add it again, or `codex plugin marketplace upgrade` for a Git-sourced marketplace. Then start a new Codex thread; Codex only reloads skills at thread start.

## Where things live

| Path | What |
|---|---|
| `plugins/claude/scripts/claude-companion.mjs` | CLI entry point: `setup`, `task`, `review`, `status`, `result`, `cancel` |
| `plugins/claude/scripts/lib/` | One module per concern: args, process, env, state, claude, git, prompts, jobs, render |
| `plugins/claude/skills/*/SKILL.md` | What Codex reads. Keep them thin forwarders. |
| `plugins/claude/prompts/` | The system prompt appended to every run and the review templates |
| `tests/` | One test file per module plus `cli.test.mjs` end to end |
| `docs/superpowers/` | The original design spec and implementation plan |

## Ground rules

- Every script must run unchanged on macOS, Linux, and Windows. Spawn processes directly, never through a shell; no bash, no assumptions about path separators. CI runs all three.
- Read-only stays the default. Anything that lets Claude edit or run commands must be an explicit flag.
- The companion never invents an answer when Claude did not run. Failures print an actionable message first, then any stderr Claude produced.
- Add or update a test with every behaviour change. `node --test tests/<file>.test.mjs` runs one file.
- Never commit state files, logs, `.env` files, or anything from `~/.codex` or `~/.claude`.

## Sending a change

Open a pull request against `main` with a short description of the behaviour change and how you tested it. The PR template has a checklist. Small, focused PRs get merged fastest.

## Reporting a security issue

See [SECURITY.md](SECURITY.md). Please do not open a public issue for vulnerabilities.
