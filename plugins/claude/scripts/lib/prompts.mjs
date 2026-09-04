import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  return fs.readFileSync(path.join(rootDir, "prompts", `${name}.md`), "utf8");
}

export function interpolateTemplate(template, vars = {}) {
  return String(template).replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => String(vars[key] ?? ""));
}

export function loadCodexContext(rootDir) {
  return loadPromptTemplate(rootDir, "codex-context").trim();
}

export function buildReviewPrompt(rootDir, { adversarial = false, targetLabel, focus = "", context }) {
  const template = loadPromptTemplate(rootDir, adversarial ? "adversarial-review" : "review");
  return interpolateTemplate(template, {
    TARGET_LABEL: targetLabel,
    USER_FOCUS: String(focus ?? "").trim() || "(none)",
    REVIEW_INPUT: context
  });
}
