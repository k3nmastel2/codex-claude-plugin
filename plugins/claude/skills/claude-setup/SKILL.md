---
name: claude-setup
description: Check whether Claude Code's CLI is installed and logged in so the other claude-* skills can run, and tell the user exactly what to do if not. Use when a claude-* skill reports a missing binary or login, or when the user asks to set up or verify Claude.
---

# Claude Setup

Run exactly one command and return its stdout verbatim:

```
node "<plugin-root>/scripts/claude-companion.mjs" setup
```

`<plugin-root>` is two directories above this SKILL.md, i.e. `<this skill's directory>/../../scripts/claude-companion.mjs`.

## Rules

- If Claude Code is missing, show the install pointer from the output and stop. Do not install it without the user asking.
- If Claude Code is installed but not logged in, tell the user to run `claude auth login` in their own terminal. Never attempt to log in, paste tokens, or set credentials yourself.
- If the output reports the nesting guard is active, explain that this Codex session was started from inside Claude Code and the plugin refuses to nest.
- When everything is ready, say so in one line.

## Sandbox

The companion needs network access (Claude's API) and the user's Claude login. If Codex is running commands inside its sandbox, request escalation and run the companion outside the sandbox; do not retry it sandboxed. Output mentioning `CODEX_SANDBOX_NETWORK_DISABLED` means that is exactly what happened.
