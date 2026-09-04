---
name: claude
description: One-word entry point for Claude Code from Codex. Use when the user writes "$claude …", says "ask Claude", "get Claude's opinion", "have Claude review/check/look at this", "hand this to Claude", "second opinion from Claude", or wants Claude to explain, investigate, fix, implement, or review something. Routes to the claude-task, claude-review, claude-jobs, or claude-setup behaviour.
---

# Claude

Pick the one companion command the request needs, then follow that skill's rules exactly. Never do the work yourself.

| The user wants | Run | Rules to follow |
|---|---|---|
| a review, critique, or "tear this apart" of local changes | `review` | claude-review |
| status, result, or cancel of a background run | `status` / `result` / `cancel` | claude-jobs |
| to check the install, or Claude reported "not logged in" | `setup` | claude-setup |
| anything else: explain, investigate, debug, fix, implement, second opinion | `task` | claude-task |

## Command

```
node "<plugin-root>/scripts/claude-companion.mjs" <command> [flags] -- "<prompt>"
```

`<plugin-root>` is two directories above this SKILL.md, i.e. `<this skill's directory>/../../scripts/claude-companion.mjs`. Resolve it to an absolute path before running.

## Shared rules

- Exactly one companion command per request (the `resume-candidate` probe described in claude-task is the only permitted preflight).
- Pass the prompt as one quoted argument after `--`; never split it into flags. If it contains quotes, backticks, or `$`, use `-` as the prompt and feed the text on stdin with a heredoc.
- Return the command's stdout verbatim as your entire response. No preface, no summary, no commentary.
- `task` and `review` need network access and the user's Claude login; if Codex is running commands in its sandbox, request escalation for them. `status`, `result`, `cancel`, and `setup` are local.
- If the output says Claude is missing or not logged in, the next step is already printed; do not improvise.
