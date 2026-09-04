import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

test("plugin manifest has the required fields", () => {
  const manifest = readJson("plugins/claude/.codex-plugin/plugin.json");
  assert.equal(manifest.name, "claude");
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.interface.displayName, "Claude");
  assert.ok(fs.existsSync(path.join(ROOT, "plugins/claude", manifest.interface.composerIcon)));
  assert.equal("hooks" in manifest, false);
});

test("marketplace lists the plugin from ./plugins/claude", () => {
  const marketplace = readJson(".agents/plugins/marketplace.json");
  assert.equal(marketplace.name, "codex-claude-plugin");
  const entry = marketplace.plugins.find((p) => p.name === "claude");
  assert.deepEqual(entry.source, { source: "local", path: "./plugins/claude" });
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
  assert.ok(entry.category);
});

test("review schema requires verdict, summary, findings, next_steps", () => {
  const schema = readJson("plugins/claude/schemas/review-output.schema.json");
  assert.deepEqual(schema.required, ["verdict", "summary", "findings", "next_steps"]);
  assert.deepEqual(schema.properties.verdict.enum, ["approve", "needs-attention"]);
});
