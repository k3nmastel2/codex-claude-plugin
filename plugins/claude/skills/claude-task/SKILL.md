---
name: claude-task
description: Delegate a coding task, investigation, debugging pass, or second opinion to Claude Code running locally through its CLI. Use when the user names Claude, asks for a second implementation or diagnosis pass, or hands work to Claude explicitly. Not for ordinary work Codex can finish itself.
---

# Claude Task

You are a forwarder. Build exactly one companion command, run it, and return its stdout verbatim.

## Command

```
node "<plugin-root>/scripts/claude-companion.mjs" task [flags] -- "<prompt>"
```

`<plugin-root>` is two directories above this SKILL.md, i.e. `<this skill's directory>/../../scripts/claude-companion.mjs`. Resolve it to an absolute path before running. Quote the prompt as one argument after `--`.

## Flag mapping

- Default is read-only: Claude can read and search but cannot edit or run commands.
- `--write` when the user wants Claude to change files.
- `--full` when the user wants Claude to also run commands or tests, or says "full access". Warn once that this skips every permission check.
- `--allow "<rule>"` (repeatable) to allow specific tools, e.g. `--allow "Bash(npm test:*)"`.
- `--resume` to continue the last Claude thread in this repository; `--fresh` to force a new one.
- `--model <name>` and `--effort <low|medium|high|xhigh|max>` only when the user asks for them; otherwise leave both unset.
- `--background` when the user asks for it, or when the task is open-ended, multi-step, or likely to take more than a few minutes. Otherwise run in the foreground.
- `--allow-nested` only when the user explicitly asks to override the loop guard.

## Before running

If the request reads like a follow-up ("continue", "keep going", "apply the top fix", "dig deeper") and the user did not say `--resume` or `--fresh`, run `node "<plugin-root>/scripts/claude-companion.mjs" resume-candidate --json` first. If `available` is `true`, add `--resume`; otherwise run fresh.

## Rules

- Set the shell command timeout to at least 1,500,000 ms (25 minutes) for foreground runs. Background runs return immediately.
- Return the command's stdout verbatim. Do not summarise, paraphrase, or add commentary before or after it.
- Do not do the task yourself, inspect files on Claude's behalf, or retry with a different prompt.
- If the output says Claude is not installed or not logged in, tell the user to run `$claude-setup` and stop.
- If the command exits non-zero, show its output and stop. Never invent an answer Claude did not give.
- For a background job, tell the user to use `$claude-jobs` to check status or fetch the result.

## Sandbox

The companion needs network access (Claude's API) and the user's Claude login. If Codex is running commands inside its sandbox, request escalation and run the companion outside the sandbox; do not retry it sandboxed. Output mentioning `CODEX_SANDBOX_NETWORK_DISABLED` means that is exactly what happened.
