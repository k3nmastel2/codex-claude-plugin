import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const SKILLS = ["claude-task", "claude-review", "claude-setup", "claude-jobs"];

test("every skill has frontmatter, a companion reference, verbatim rule, and openai.yaml", () => {
  for (const name of SKILLS) {
    const dir = path.join(ROOT, "plugins", "claude", "skills", name);
    const skill = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^---\\r?\\nname: ${name}\\r?\\ndescription: .+\\r?\\n---`), name);
    assert.match(skill, /\.\.\/\.\.\/scripts\/claude-companion\.mjs/, name);
    assert.match(skill, /verbatim/, name);
    const yaml = fs.readFileSync(path.join(dir, "agents", "openai.yaml"), "utf8");
    assert.match(yaml, /display_name: "/, name);
    assert.match(yaml, new RegExp(`default_prompt: ".*\\$${name}`), name);
  }
});

test("review and setup skills never escalate permissions or log in", () => {
  const review = fs.readFileSync(path.join(ROOT, "plugins/claude/skills/claude-review/SKILL.md"), "utf8");
  assert.match(review, /Never apply fixes/);
  assert.equal(review.includes("--write"), false);
  const setup = fs.readFileSync(path.join(ROOT, "plugins/claude/skills/claude-setup/SKILL.md"), "utf8");
  assert.match(setup, /never attempt to log in/i);
});
