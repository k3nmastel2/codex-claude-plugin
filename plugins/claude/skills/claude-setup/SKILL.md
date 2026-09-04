---
name: claude-setup
description: Check whether Claude Code's CLI is installed and logged in so the other claude skills can run, and tell the user exactly what to do if not. Use when a claude skill reports a missing binary or login, or when the user says "is Claude set up", "set up Claude", "check Claude".
---

# Claude Setup

Run exactly one command and return its stdout verbatim as your entire response; it already contains the next steps.

```
node "<plugin-root>/scripts/claude-companion.mjs" setup
```

`<plugin-root>` is two directories above this SKILL.md, i.e. `<this skill's directory>/../../scripts/claude-companion.mjs`. Resolve it to an absolute path before running.

## Rules

- Do not install Claude Code, change configuration, or run any other command; the report tells the user what to do.
- Never attempt to log in, paste tokens, or set credentials yourself. Logging in is the user's action, in their own terminal.
- `setup` is local; run it in the sandbox without requesting escalation. If the report says the sandbox has network disabled, that only affects `task` and `review`, and the report explains the fix.
