import { test } from "node:test";
import assert from "node:assert/strict";
import { runClaude, getClaudeAvailability, getClaudeAuthStatus, parseResultEnvelope, buildClaudeArgs } from "../plugins/claude/scripts/lib/claude.mjs";
import { FAKE_CLAUDE_CMD, cleanEnv, makeTempDir } from "./helpers.mjs";

const baseEnv = (extra = {}) => ({ ...cleanEnv(), CLAUDE_COMPANION_CLAUDE_CMD: FAKE_CLAUDE_CMD, ...extra });

test("runClaude delivers the prompt on stdin and scrubs the env", async () => {
  const cwd = makeTempDir();
  const prompt = "explain the auth flow";
  const run = await runClaude({ cwd, env: baseEnv({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x" }), prompt, claudeArgs: buildClaudeArgs({ permission: "read" }) });
  assert.equal(run.status, 0);
  const { envelope } = parseResultEnvelope(run.stdout);
  assert.equal(envelope.fake.stdinLength, prompt.length);
  assert.equal(envelope.fake.claudecode, null);
  assert.equal(envelope.fake.depth, "1");
  assert.ok(envelope.fake.argv.includes("dontAsk"));
});

test("runClaude can pass the prompt in argv when asked", async () => {
  const run = await runClaude({ cwd: makeTempDir(), env: baseEnv({ CLAUDE_COMPANION_PROMPT_VIA_ARGV: "1" }), prompt: "hi there", claudeArgs: buildClaudeArgs({ permission: "read" }) });
  const { envelope } = parseResultEnvelope(run.stdout);
  assert.equal(envelope.fake.argv.at(-1), "hi there");
  assert.equal(envelope.fake.argv.at(-2), "--");
  assert.equal(envelope.fake.stdinLength, 0);
});

test("runClaude surfaces auth errors with exit status 1", async () => {
  const run = await runClaude({ cwd: makeTempDir(), env: baseEnv({ FAKE_CLAUDE_MODE: "auth-error" }), prompt: "x", claudeArgs: [] });
  assert.equal(run.status, 1);
  assert.equal(parseResultEnvelope(run.stdout).envelope.is_error, true);
});

test("runClaude enforces the timeout", async () => {
  const run = await runClaude({ cwd: makeTempDir(), env: baseEnv({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLEEP_MS: "5000" }), prompt: "x", claudeArgs: [], timeoutMs: 400 });
  assert.equal(run.timedOut, true);
});

test("runClaude reports a missing binary", async () => {
  const run = await runClaude({ cwd: makeTempDir(), env: { ...cleanEnv(), CLAUDE_COMPANION_CLAUDE_CMD: "definitely-not-a-binary-xyz" }, prompt: "x", claudeArgs: [] });
  assert.equal(run.error?.code, "ENOENT");
});

test("availability and auth probes read the fixture", () => {
  assert.deepEqual(getClaudeAvailability(baseEnv()), { available: true, detail: "2.1.261 (Claude Code)" });
  assert.equal(getClaudeAuthStatus(baseEnv()).loggedIn, true);
  assert.equal(getClaudeAuthStatus(baseEnv({ FAKE_CLAUDE_LOGGED_IN: "false" })).loggedIn, false);
  assert.equal(getClaudeAvailability({ ...cleanEnv(), CLAUDE_COMPANION_CLAUDE_CMD: "definitely-not-a-binary-xyz" }).available, false);
});
