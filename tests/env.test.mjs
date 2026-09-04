import { test } from "node:test";
import assert from "node:assert/strict";
import { detectNesting, buildChildEnv, shouldScrub, readDepth, DEPTH_ENV, PARENT_ENV } from "../plugins/claude/scripts/lib/env.mjs";

test("fresh environment is not nested", () => {
  const report = detectNesting({ PATH: "/usr/bin" });
  assert.deepEqual(report, { nested: false, depth: 0, maxDepth: 1, reason: null });
});

test("depth at or above max is nested", () => {
  const report = detectNesting({ CLAUDE_COMPANION_DEPTH: "1" });
  assert.equal(report.nested, true);
  assert.match(report.reason, /depth 1/);
});

test("inherited CLAUDECODE=1 is nested", () => {
  const report = detectNesting({ CLAUDECODE: "1" });
  assert.equal(report.nested, true);
  assert.match(report.reason, /Claude Code session/);
});

test("max depth can be raised and allowNested overrides", () => {
  assert.equal(detectNesting({ CLAUDE_COMPANION_DEPTH: "1", CLAUDE_COMPANION_MAX_DEPTH: "2" }).nested, false);
  assert.equal(detectNesting({ CLAUDECODE: "1" }, { allowNested: true }).nested, false);
});

test("readDepth tolerates garbage", () => {
  assert.equal(readDepth({ CLAUDE_COMPANION_DEPTH: "banana" }), 0);
  assert.equal(readDepth({ CLAUDE_COMPANION_DEPTH: "3" }), 3);
});

test("shouldScrub matches Claude session variables but not ANTHROPIC_*", () => {
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_PLUGIN_DATA", "CODEX_COMPANION_SESSION_ID"]) {
    assert.equal(shouldScrub(name), true, name);
  }
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "PATH", "CODEX_HOME"]) {
    assert.equal(shouldScrub(name), false, name);
  }
});

test("buildChildEnv scrubs, increments depth, and tags the parent", () => {
  const child = buildChildEnv({ PATH: "/usr/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "x", ANTHROPIC_API_KEY: "k", CLAUDE_COMPANION_DEPTH: "0" });
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.ANTHROPIC_API_KEY, "k");
  assert.equal("CLAUDECODE" in child, false);
  assert.equal("CLAUDE_CODE_ENTRYPOINT" in child, false);
  assert.equal(child[DEPTH_ENV], "1");
  assert.equal(child[PARENT_ENV], "codex");
});

test("detectSandbox recognises Codex's sandbox markers", async () => {
  const { detectSandbox } = await import("../plugins/claude/scripts/lib/env.mjs");
  assert.deepEqual(detectSandbox({ PATH: "/usr/bin" }), { sandboxed: false, networkDisabled: false, reason: null });
  const blocked = detectSandbox({ CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1" });
  assert.equal(blocked.networkDisabled, true);
  assert.match(blocked.reason, /escalated permissions/);
  assert.match(blocked.reason, /network_access = true/);
  const allowed = detectSandbox({ CODEX_SANDBOX: "seatbelt" });
  assert.equal(allowed.sandboxed, true);
  assert.equal(allowed.networkDisabled, false);
});
