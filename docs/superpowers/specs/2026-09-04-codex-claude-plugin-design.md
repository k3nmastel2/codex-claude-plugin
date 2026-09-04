# Codex → Claude plugin — design

Date: 2026-09-04
Status: approved design, pre-implementation

## Goal

Give Codex CLI (and the Codex desktop app) the ability to delegate work to Claude Code
through Claude's local CLI, the mirror image of OpenAI's `codex` plugin for Claude Code.
No Anthropic API key is required: the plugin drives `claude -p` (headless print mode),
which uses whatever credentials the user's Claude Code install already has.

Ship it as a public GitHub repository that is simultaneously a Codex marketplace, so
anyone can install it with two commands, and so it syncs across the author's machines.

## Non-goals

- No stop-time review gate. Codex plugins do not support hooks.
- No Claude-side changes. Claude's existing `codex` plugin stays as-is.
- No MCP server. The Codex `visualize`/`sites` style of MCP plugin is not the right shape;
  a script plus skills is simpler and matches the Codex-companion design.
- No prompt-engineering skill in v1 (the Codex plugin's `gpt-5-4-prompting` analogue).

## Repository layout

```
codex-claude-plugin/
  .agents/plugins/marketplace.json        # repo doubles as a Codex marketplace
  plugins/claude/
    .codex-plugin/plugin.json             # Codex plugin manifest (name: "claude")
    assets/claude-plugin.svg
    skills/
      claude-task/SKILL.md, agents/openai.yaml
      claude-review/SKILL.md, agents/openai.yaml
      claude-setup/SKILL.md, agents/openai.yaml
      claude-jobs/SKILL.md, agents/openai.yaml
    scripts/
      claude-companion.mjs                # CLI entry point
      lib/args.mjs                        # argv parsing + raw-string splitting
      lib/process.mjs                     # cross-platform spawn / kill tree
      lib/claude.mjs                      # locate claude, build argv, run, parse envelope
      lib/env.mjs                         # env scrubbing + depth guard
      lib/state.mjs                       # per-workspace state + job files
      lib/jobs.mjs                        # foreground/background job lifecycle
      lib/git.mjs                         # review target + context collection
      lib/prompts.mjs                     # template loading/interpolation
      lib/render.mjs                      # text rendering of every command
    prompts/
      codex-context.md                    # appended system prompt for every run
      review.md
      adversarial-review.md
    schemas/review-output.schema.json
  tests/                                  # node --test, no dependencies
    fixtures/fake-claude.mjs              # stand-in for the claude binary
    *.test.mjs
  .github/workflows/test.yml              # ubuntu + macos + windows matrix
  package.json                            # private; "test": "node --test tests/"
  README.md  LICENSE (MIT)  CHANGELOG.md  .gitignore
  docs/superpowers/specs/                 # this document
```

Runtime requirements: Node.js 20 or newer, Claude Code CLI installed and logged in,
Codex CLI 0.145 or newer. No npm dependencies at runtime or in tests.

## Install

For anyone:

```bash
codex plugin marketplace add k3nmastel2/codex-claude-plugin
codex plugin add claude@codex-claude-plugin
```

For a local clone:

```bash
codex plugin marketplace add ~/GitHub/codex-claude-plugin
codex plugin add claude@codex-claude-plugin
```

Prerequisite the plugin cannot do for the user: `claude auth login` (or an
`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` in the environment). `$claude-setup`
detects the missing login and tells the user exactly what to run.

Updating a local clone during development follows Codex's cachebuster flow: bump the
manifest version suffix (`0.1.0+codex.<timestamp>`) and re-run `codex plugin add`.

## Companion CLI

Entry point: `node <plugin-root>/scripts/claude-companion.mjs <command> [args]`.
Skills reference it relative to their own directory (`../../scripts/claude-companion.mjs`).

### Commands

| Command | Purpose |
|---|---|
| `setup [--json]` | Report whether node, `claude`, and login are ready; print next steps. |
| `task [flags] [--] <prompt>` | Run one Claude turn (or a resumed thread) and print the answer. |
| `review [flags] [focus...]` | Read-only structured code review of local git state. |
| `status [job-id] [--all] [--json]` | Show running and recent jobs for this workspace. |
| `result [job-id] [--json]` | Print the stored output of a finished job. |
| `cancel [job-id] [--json]` | Kill a running background job's process tree. |
| `resume-candidate --json` | Report whether a resumable Claude session exists for this workspace. |

All commands accept `-C <cwd>` / `--cwd <cwd>` and `--json`. A single raw argument
string (how a skill will usually pass the user's text) is split with shell-like quoting
rules before parsing, mirroring the Codex companion.

### `task` flags

| Flag | Effect |
|---|---|
| (default) | Read-only: `--permission-mode dontAsk` plus `--disallowedTools Edit,Write,MultiEdit,NotebookEdit`. |
| `--write` | `--permission-mode acceptEdits`: file edits inside the workspace auto-approved; shell commands still denied unless allowed. |
| `--full` | `--dangerously-skip-permissions`: no permission checks at all. |
| `--allow <rule>` (repeatable) | Adds `--allowedTools <rule>` entries, e.g. `--allow "Bash(npm test:*)"`. |
| `--resume` / `--fresh` | Continue the workspace's last Claude session, or force a new one. Default: fresh. |
| `--model <name>` | Passed to `--model`. Unset by default. |
| `--effort <level>` | Passed to `--effort`. Accepted: `low`, `medium`, `high`, `xhigh`, `max`. Unset by default. |
| `--max-turns <n>` | Passed through. |
| `--max-budget-usd <x>` | Passed through. |
| `--add-dir <dir>` (repeatable) | Passed through. |
| `--timeout-ms <n>` | Foreground wall-clock limit. Default 20 minutes. Background default 2 hours. |
| `--background` | Detach and return a job id immediately. |
| `-` as prompt, or no prompt with piped stdin | Read the prompt from stdin. |

### `review` flags

`--adversarial`, `--base <ref>`, `--scope auto|working-tree|branch`, `--background`,
`--model`, `--effort`, `--timeout-ms`, trailing focus text. Review always runs
read-only and always requests structured output with the bundled JSON schema.

### Claude invocation

Every run builds this argv:

```
claude -p --output-format json
  --permission-mode <dontAsk|acceptEdits> | --dangerously-skip-permissions
  [--disallowedTools ...] [--allowedTools ...]
  [--resume <session-id>] [--model ...] [--effort ...] [--max-turns ...] [--max-budget-usd ...]
  [--add-dir ...]...
  --name "Codex → Claude: <first 56 chars of prompt>"
  --append-system-prompt <contents of prompts/codex-context.md>
  [--json-schema <schema JSON>]
```

The prompt is written to the child's stdin, never placed in argv. This sidesteps
Windows argument-length limits and shell quoting for large review contexts. The first
real end-to-end run must confirm that `claude -p` with no positional prompt reads
stdin; if it does not, fall back to passing the prompt as the final positional argument
and record that in the CHANGELOG.

`claude` is located by PATH lookup. `CLAUDE_COMPANION_CLAUDE_CMD` overrides the command
(whitespace-split; used by tests to point at the fake binary). On Windows the spawn uses
a shell so `claude.cmd` shims resolve, as the Codex companion does.

### Result envelope

`claude -p --output-format json` prints one JSON object. Fields the companion relies on:
`type` (`"result"`), `is_error`, `result` (final text), `session_id`, `num_turns`,
`total_cost_usd`, `duration_ms`, `structured_output` (only with `--json-schema`),
`permission_denials`, `terminal_reason`. Exit code is non-zero on failure and the error
text is in `result` (observed: "Failed to authenticate: OAuth session expired…").

Parsing rules: take the last line of stdout that parses as a JSON object with
`type === "result"`. Missing or unparsable output is a failure with stderr excerpt.
Review uses `structured_output` when present, otherwise attempts to parse `result` as
JSON, otherwise reports malformed output and prints the raw text.

### Output rendering (text mode)

- `task`: Claude's `result` verbatim, a blank line, then one trailer line:
  `claude session <id> · <n> turns · $<cost> · resume with --resume`.
  If Claude denied tool calls, a second trailer line lists them (helps the user decide
  whether `--write` or `--allow` is needed).
- `review`: `# Claude Review (<target label>)`, verdict, summary, findings sorted
  critical → low with `file:line_start-line_end`, confidence, body, recommendation, then
  next steps. An empty findings list says so explicitly.
- `setup`: readiness table plus numbered next steps.
- `status`: running jobs, latest finished, recent jobs, each with id, kind, status,
  elapsed/duration, prompt excerpt, and the follow-up command.
- `result` / `cancel`: stored payload, or the cancel report.
- Failures: one actionable line, then up to 20 trimmed stderr lines. Exit code 1.

`--json` prints the full payload:
`{ ok, command, cwd, jobId, sessionId, numTurns, costUsd, durationMs, result,
structuredOutput, permissionDenials, targetLabel, error, stderr }`.

## Permissions and safety

- Default read-only. `--write` and `--full` must be explicit. The `claude-review` skill
  never passes either.
- `prompts/codex-context.md` is appended to Claude's system prompt on every run. It says:
  Claude was invoked by Codex through this plugin; the calling agent will read the
  final message; do not delegate to Codex, do not invoke `/codex:*` commands or the
  `codex-rescue` subagent; do not ask questions (there is nobody to answer), state
  assumptions instead; finish with a self-contained final message.
- Claude runs with the user's own Claude Code credentials, settings, plugins, and
  billing. The README says so plainly and warns about `--full`.

## Loop guard and environment hygiene

The companion refuses to run when nesting is detected, unless `--allow-nested` is set:

- `CLAUDE_COMPANION_DEPTH` (default 0) is at or above `CLAUDE_COMPANION_MAX_DEPTH`
  (default 1), or
- `CLAUDECODE=1` is inherited, meaning this Codex was itself spawned by a Claude session.

The child environment is the parent environment minus every `CLAUDECODE`,
`CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_VERSION`,
`CLAUDE_PLUGIN_*`, and `CODEX_COMPANION_*` variable, plus
`CLAUDE_COMPANION_DEPTH=<depth+1>` and `CLAUDE_COMPANION_PARENT=codex`.
`ANTHROPIC_*` variables are kept so API-key users keep working.

The bound this gives: Codex → Claude → (Claude's codex plugin) Codex → this plugin
refuses. One extra hop at most.

## State

Root: `${CLAUDE_COMPANION_STATE_DIR}` if set, else `${CODEX_HOME:-~/.codex}/claude-companion/state/`.
Per workspace: `<basename-slug>-<sha256(realpath)[:16]>/` containing `state.json`,
`jobs/<id>.json`, `jobs/<id>.log`. Workspace root is the git top-level when inside a
repo, otherwise the cwd.

`state.json` (synthetic values; timestamps are ISO 8601 UTC):

```json
{
  "version": 1,
  "lastSession": { "sessionId": "00000000-0000-4000-8000-000000000000",
                   "createdAt": "2026-09-04T17:00:00.000Z", "cwd": "/path/to/repo",
                   "promptExcerpt": "Explain the auth flow" },
  "jobs": [ { "id": "job-xxxxxx-yyyy", "kind": "task", "status": "succeeded",
              "pid": 12345, "createdAt": "2026-09-04T17:00:00.000Z",
              "updatedAt": "2026-09-04T17:01:00.000Z", "finishedAt": "2026-09-04T17:01:00.000Z",
              "cwd": "/path/to/repo", "promptExcerpt": "Explain the auth flow",
              "sessionId": "00000000-0000-4000-8000-000000000000",
              "logFile": "/state/jobs/job-xxxxxx-yyyy.log",
              "exitCode": 0, "error": null, "summary": "First line of the answer",
              "background": false } ]
}
```

Job `kind` is `task` or `review`; `status` is one of `queued`, `running`, `succeeded`,
`failed`, `cancelled`. At most 50 jobs are kept; pruned jobs lose their files.
`lastSession` is updated after every successful `task` (review sessions are not
resumable by design).

## Background jobs

`--background` records a queued job, then spawns
`node claude-companion.mjs __worker <job-id>` detached (own process group on POSIX,
`windowsHide` on Windows) with stdout and stderr redirected to the job log, and exits
printing the job id and the `status`/`result`/`cancel` commands. The worker re-reads its
job file for the full argument set, runs Claude, writes the payload into the job file,
and marks the job succeeded or failed. Foreground runs record a job too, so `status`
shows history either way.

`cancel` terminates the process tree: `SIGTERM` to the process group on POSIX,
`taskkill /PID <pid> /T /F` on Windows, with the Codex companion's fallbacks. A cancelled
job keeps its partial log.

Foreground runs enforce `--timeout-ms`; on expiry the tree is killed and the job is
marked failed with a timeout reason.

## Review target and context

Target resolution mirrors the Codex companion:

- `--scope auto` (default): working tree if `git status --porcelain` is non-empty, else
  branch mode against the detected base.
- Base detection: `--base <ref>` if given, else `origin/HEAD`, else `main`, else `master`.
- Working-tree context: `git status --short --untracked-files=all`, `git diff HEAD`
  (staged plus unstaged), and the contents of untracked text files up to 24 KB each.
- Branch context: `git log --oneline <merge-base>..HEAD` and `git diff <base>...HEAD`.
- If the inline diff exceeds 256 KB, the prompt includes the changed-file list and the
  diff stat instead, and tells Claude to read the files itself (Claude has read tools).

The review prompt asks for JSON matching `schemas/review-output.schema.json`, which is
the Codex plugin's schema verbatim: `verdict` (`approve` | `needs-attention`),
`summary`, `findings[]` (`severity`, `title`, `body`, `file`, `line_start`, `line_end`,
`confidence`, `recommendation`), `next_steps[]`. `--adversarial` swaps in the
adversarial template, adapted from the Codex plugin's, with Claude named as the reviewer.

## Skills (what Codex sees)

Each SKILL.md is a thin forwarder. Shared rules: build exactly one companion command,
run it with a generous shell timeout (at least 25 minutes for foreground `task` and
`review`), return stdout verbatim, add no commentary, do not do the work yourself, do not
poll or inspect files on the user's behalf, and on any failure show the companion's
output and stop.

- `claude-task` — Delegate a task, investigation, or second opinion to Claude Code.
  Flag mapping rules for `--write`/`--full`/`--allow`/`--resume`/`--fresh`/`--model`/
  `--effort`/`--background`. Before a fresh run, call `resume-candidate --json`; if a
  session is available and the request reads like a follow-up ("continue", "keep going",
  "apply the top fix"), add `--resume`; otherwise run fresh. If the companion reports
  Claude is missing or not logged in, point the user to `$claude-setup`.
- `claude-review` — Read-only review of local git state. Mapping for `--adversarial`,
  `--base`, `--scope`, `--background`, focus text. After presenting findings, stop and
  ask which, if any, to fix. Never apply fixes.
- `claude-setup` — Run `setup`. If Claude is missing, show the official install command
  and offer nothing else. If not logged in, tell the user to run `claude auth login` in
  their own terminal; never attempt login.
- `claude-jobs` — `status`, `result`, `cancel` with job-id passthrough.

Every skill ships `agents/openai.yaml` with a display name, a short description, and a
`default_prompt` that names the skill with `$`.

## Errors

| Condition | Behaviour |
|---|---|
| `claude` not on PATH | `setup` reports it; `task`/`review` fail with the install pointer. |
| Not logged in / expired OAuth | Detected from the envelope's `is_error` + auth text, or from `setup`'s `claude auth status` exit code. Message names `claude auth login`. |
| Nesting detected | Refuse before spawning; explain the depth guard and `--allow-nested`. |
| Timeout | Kill tree, job failed, message includes the limit and `--timeout-ms`. |
| Non-JSON or empty stdout | Failure with stderr excerpt and raw stdout tail. |
| Schema output missing | Review falls back to parsing `result`; else prints raw text under a "malformed" notice. |
| Permission denials | Never an error; listed in the trailer so the caller can escalate. |

The companion never fabricates an answer when Claude did not run.

## Testing

`npm test` runs `node --test tests/`. Tests never call the real `claude`; they set
`CLAUDE_COMPANION_CLAUDE_CMD` to `node tests/fixtures/fake-claude.mjs`, which reads
`FAKE_CLAUDE_MODE` (`ok`, `structured`, `auth-error`, `slow`, `denied`, `garbage`),
echoes the argv it received into the envelope, and echoes stdin length, so tests can
assert on the exact flags and prompt delivery.

Coverage targets, one test file per module:

- `args`: raw-string splitting, value/boolean flags, repeatable `--allow`, `--` passthrough.
- `env`: scrub list, depth increment, nesting refusal, `--allow-nested`.
- `claude`: argv for each permission level, resume, model/effort, schema; envelope
  parsing including last-line selection and error mapping.
- `state`: dir derivation, lastSession update, job pruning at 50, overrides via env.
- `git`: target resolution and context collection against temp repos (dirty tree,
  clean branch, no origin, untracked binary skipped, oversize diff fallback).
- `jobs`: foreground record, background spawn → running → succeeded, cancel → cancelled,
  timeout → failed.
- `render`: task trailer, review ordering, setup steps, status table, failure format.
- `cli`: end-to-end through the entry point with the fake binary for `setup`, `task`,
  `review`, `status`, `result`, `cancel`, `resume-candidate`.

CI: GitHub Actions matrix on ubuntu-latest, macos-latest, windows-latest with Node 20
and 22. Windows is a first-class target, not a follow-up.

Manual acceptance after the user runs `claude auth login`: `setup` reports ready;
`$claude-task` answers a trivial question from a Codex session; `$claude-review` on a
dirty repo returns structured findings; a `--background` job completes and `result`
prints it; nesting from a Claude-spawned Codex is refused.

## Open items resolved during exploration

- Codex plugins cannot include hooks, commands, or agents; skills are the only surface.
- `codex plugin marketplace add` accepts `owner/repo`, HTTPS, SSH, or a local path.
- `--bare` would isolate the child from plugins but forces API-key auth, so it is not used.
- Selective plugin disabling in Claude is undocumented; the loop guard plus the appended
  system prompt are the mitigation.
