import { test } from "node:test";
import assert from "node:assert/strict";
import { createJob, executeJob, excerpt } from "../plugins/claude/scripts/lib/jobs.mjs";
import { getJob, getLastSession, readJobFile } from "../plugins/claude/scripts/lib/state.mjs";
import { buildClaudeArgs } from "../plugins/claude/scripts/lib/claude.mjs";
import { FAKE_CLAUDE_CMD, makeTempDir, withStateDir } from "./helpers.mjs";

const envFor = (extra = {}) => withStateDir({ CLAUDE_COMPANION_CLAUDE_CMD: FAKE_CLAUDE_CMD, ...extra });
const request = (overrides = {}) => ({ prompt: "explain auth", claudeArgs: buildClaudeArgs({ permission: "read" }), timeoutMs: 10000, structured: false, targetLabel: null, ...overrides });

test("excerpt collapses whitespace and truncates", () => {
  assert.equal(excerpt("  a   b\n c "), "a b c");
  assert.equal(excerpt("x".repeat(200), 10), "xxxxxxx...");
});

test("createJob records a queued job and writes the request file", () => {
  const env = envFor();
  const ws = makeTempDir();
  const job = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "explain auth", background: false, request: request() }, env);
  assert.match(job.id, /^job-/);
  assert.equal(getJob(ws, job.id, env).status, "queued");
  assert.equal(readJobFile(ws, job.id, env).request.prompt, "explain auth");
});

test("executeJob succeeds, stores the payload, and remembers the session for tasks", async () => {
  const env = envFor({ FAKE_CLAUDE_SESSION_ID: "sess-42" });
  const ws = makeTempDir();
  const job = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "explain auth", background: false, request: request() }, env);
  const payload = await executeJob(ws, job.id, env);
  assert.equal(payload.ok, true);
  assert.equal(payload.sessionId, "sess-42");
  assert.match(payload.result, /fake answer for: explain auth/);
  assert.equal(getJob(ws, job.id, env).status, "succeeded");
  assert.equal(getLastSession(ws, env).sessionId, "sess-42");
  assert.equal(readJobFile(ws, job.id, env).result.ok, true);
});

test("review jobs keep structured output and never touch lastSession", async () => {
  const env = envFor({ FAKE_CLAUDE_MODE: "structured" });
  const ws = makeTempDir();
  const job = createJob(ws, { kind: "review", cwd: ws, promptExcerpt: "review", background: false, request: request({ structured: true, targetLabel: "working tree" }) }, env);
  const payload = await executeJob(ws, job.id, env);
  assert.equal(payload.structuredOutput.verdict, "needs-attention");
  assert.equal(payload.targetLabel, "working tree");
  assert.equal(getLastSession(ws, env), null);
});

test("auth failures mark the job failed with an actionable error", async () => {
  const env = envFor({ FAKE_CLAUDE_MODE: "auth-error" });
  const ws = makeTempDir();
  const job = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "x", background: false, request: request() }, env);
  const payload = await executeJob(ws, job.id, env);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.kind, "auth");
  const stored = getJob(ws, job.id, env);
  assert.equal(stored.status, "failed");
  assert.match(stored.error, /claude auth login/);
});

test("timeouts fail the job and denials are reported", async () => {
  const slowEnv = envFor({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLEEP_MS: "5000" });
  const ws = makeTempDir();
  const slow = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "x", background: false, request: request({ timeoutMs: 400 }) }, slowEnv);
  const slowPayload = await executeJob(ws, slow.id, slowEnv);
  assert.equal(slowPayload.error.kind, "timeout");
  const deniedEnv = envFor({ FAKE_CLAUDE_MODE: "denied" });
  const denied = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "x", background: false, request: request() }, deniedEnv);
  const deniedPayload = await executeJob(ws, denied.id, deniedEnv);
  assert.equal(deniedPayload.ok, true);
  assert.equal(deniedPayload.permissionDenials[0].tool_name, "Edit");
});
