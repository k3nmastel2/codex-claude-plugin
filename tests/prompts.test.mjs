import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { interpolateTemplate, loadCodexContext, buildReviewPrompt } from "../plugins/claude/scripts/lib/prompts.mjs";
import { ROOT } from "./helpers.mjs";

const PLUGIN_ROOT = path.join(ROOT, "plugins", "claude");

test("interpolateTemplate replaces known keys and blanks unknown ones", () => {
  assert.equal(interpolateTemplate("a {{X}} b {{Y}}", { X: "1" }), "a 1 b ");
});

test("codex context forbids delegating back to Codex and asking questions", () => {
  const text = loadCodexContext(PLUGIN_ROOT);
  assert.match(text, /invoked by OpenAI Codex/);
  assert.match(text, /codex-rescue/);
  assert.match(text, /Do not ask/);
});

test("review prompts embed target, focus, context and demand schema JSON", () => {
  const normal = buildReviewPrompt(PLUGIN_ROOT, { adversarial: false, targetLabel: "working tree", focus: "auth", context: "DIFF-HERE" });
  assert.match(normal, /Target: working tree/);
  assert.match(normal, /User focus: auth/);
  assert.match(normal, /DIFF-HERE/);
  assert.match(normal, /needs-attention/);
  const adversarial = buildReviewPrompt(PLUGIN_ROOT, { adversarial: true, targetLabel: "branch vs main", focus: "", context: "X" });
  assert.match(adversarial, /adversarial/i);
  assert.match(adversarial, /User focus: \(none\)/);
});
