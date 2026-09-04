---
name: claude-task
description: Delegate a coding task, investigation, debugging pass, implementation, or second opinion to Claude Code running locally through its CLI. Use when the user says "ask Claude", "have Claude fix/explain/investigate", "get Claude's take", "hand this to Claude", or names Claude for anything that is not a review. Not for ordinary work Codex can finish itself.
---

# Claude Task

You are a forwarder. Build exactly one companion command, run it, and return its stdout verbatim as your entire response.

## Command

```
node "<plugin-root>/scripts/claude-companion.mjs" task [flags] -- "<prompt>"
```

`<plugin-root>` is two directories above this SKILL.md, i.e. `<this skill's directory>/../../scripts/claude-companion.mjs`. Resolve it to an absolute path before running.

Pass the user's prompt as ONE quoted argument after `--`. Never split it into separate words or flags, and never rewrite it. Prefer the stdin form for anything longer than one line or containing double quotes, backticks, or `$`: use `-` as the prompt and feed the text with a heredoc instead of escaping it.

## Flag mapping

Flags go before `--`, each as its own argument.

- Default is read-only: Claude's edit and shell tools are denied, so it can read and search but not change files or run commands. The user's own Claude Code hooks and MCP servers still load.
- `--write` when the user wants Claude to change files.
- `--full` when the user wants Claude to also run commands or tests, or says "full access". Warn once that this skips every permission check.
- `--allow "<rule>"` (repeatable) to allow specific tools, e.g. `--allow "Bash(npm test:*)"`.
- `--resume` to continue the last Claude thread in this repository; `--fresh` to force a new one.
- `--model <name>` and `--effort <low|medium|high|xhigh|max>` only when the user asks for them; otherwise leave both unset.
- `--background` when the user asks for it, or when the task is open-ended, multi-step, or likely to take more than a few minutes. Otherwise run in the foreground.
- `--allow-nested` only when the user explicitly asks to override the loop guard.

## Preflight

The `resume-candidate` probe is the only permitted preflight, and only when the request reads like a follow-up ("continue", "keep going", "apply the top fix", "dig deeper") and the user did not say `--resume` or `--fresh`: run `node "<plugin-root>/scripts/claude-companion.mjs" resume-candidate --json`; if `available` is `true`, add `--resume`. Then launch exactly one `task`.

## Rules

- Set the shell command timeout to at least 1,500,000 ms (25 minutes) for foreground runs. Background runs return immediately.
- Your entire response is the command's stdout, verbatim. Do not summarise, paraphrase, or add commentary before or after it.
- Do not do the task yourself, inspect files on Claude's behalf, or retry with a different prompt.
- If the output says Claude is not installed or not logged in, it already names the fix; show it and stop.
- If the command exits non-zero, show its output and stop. Never invent an answer Claude did not give.
- For a background job, the output already tells the user how to check on it with `$claude-jobs`.

## Sandbox

The companion needs network access (Claude's API) and the user's Claude login. If Codex is running commands inside its sandbox, request escalation and run the companion outside the sandbox; do not retry it sandboxed. Output mentioning `CODEX_SANDBOX_NETWORK_DISABLED` means that is exactly what happened.
