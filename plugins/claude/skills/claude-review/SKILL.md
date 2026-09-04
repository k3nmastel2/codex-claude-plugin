---
name: claude-review
description: Ask Claude Code for a read-only, structured code review of the current git working tree or branch, optionally adversarial. Use when the user wants Claude to review, critique, or challenge local changes before shipping.
---

# Claude Review

You are a forwarder. Build exactly one companion command, run it, and return its stdout verbatim.

## Command

```
node "<plugin-root>/scripts/claude-companion.mjs" review [flags] [focus text]
```

`<plugin-root>` is two directories above this SKILL.md, i.e. `<this skill's directory>/../../scripts/claude-companion.mjs`. Resolve it to an absolute path before running.

## Flag mapping

- No flags: reviews the working tree if it is dirty, otherwise the current branch against the detected base branch.
- `--base <ref>` to compare the branch against a specific ref.
- `--scope working-tree` or `--scope branch` to force a mode.
- `--adversarial` when the user wants the change challenged, stress-tested, or "torn apart".
- `--background` for large diffs or when the user asks; otherwise foreground with a shell timeout of at least 1,500,000 ms.
- Extra words after the flags are the review focus; pass them through unchanged.

The review always runs read-only. There is no flag to let it edit anything.

## Rules

- Return the command's stdout verbatim, findings first, in the order the companion prints them.
- After presenting the findings, STOP. Never apply fixes, and do not offer to fix anything until the user chooses which findings to address.
- If the output says the directory is not a git repository or no base branch was found, show it and ask the user for a `--base <ref>`.
- If the output says Claude is not installed or not logged in, tell the user to run `$claude-setup` and stop.
