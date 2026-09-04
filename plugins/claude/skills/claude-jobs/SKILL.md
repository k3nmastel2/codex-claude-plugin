---
name: claude-jobs
description: Show, fetch, or cancel background Claude Code jobs started by claude-task or claude-review in this repository. Use when the user asks about a running Claude job, wants its result, or wants to stop it.
---

# Claude Jobs

Run exactly one companion command and return its stdout verbatim.

```
node "<plugin-root>/scripts/claude-companion.mjs" status [job-id] [--all]
node "<plugin-root>/scripts/claude-companion.mjs" result [job-id]
node "<plugin-root>/scripts/claude-companion.mjs" cancel [job-id]
```

`<plugin-root>` is two directories above this SKILL.md, i.e. `<this skill's directory>/../../scripts/claude-companion.mjs`.

## Mapping

- "status", "is it done", "what's running" → `status`; add `--all` when the user wants full history.
- "result", "show me what Claude said" → `result` (latest finished job when no id is given).
- "cancel", "stop it" → `cancel` (most recent running job when no id is given).

## Rules

- Return stdout verbatim; do not summarise a result or reorder findings.
- Do not poll in a loop. Run the command once per user request.
- If the output says no job was found, show it and stop.
