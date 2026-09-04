import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJob, spawnBackgroundWorker, cancelJob, buildStatusSnapshot, resolveJobForResult } from "../plugins/claude/scripts/lib/jobs.mjs";
import { getJob, readJobFile } from "../plugins/claude/scripts/lib/state.mjs";
import { buildClaudeArgs } from "../plugins/claude/scripts/lib/claude.mjs";
import { ENTRY, FAKE_CLAUDE_CMD, makeTempDir, withStateDir } from "./helpers.mjs";

const envFor = (extra = {}) => withStateDir({ CLAUDE_COMPANION_CLAUDE_CMD: FAKE_CLAUDE_CMD, ...extra });
const request = (overrides = {}) => ({ prompt: "long task", claudeArgs: buildClaudeArgs({ permission: "read" }), timeoutMs: 60000, structured: false, targetLabel: null, ...overrides });

async function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("background job runs to completion in a detached worker", async () => {
  const env = envFor({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLEEP_MS: "800", FAKE_CLAUDE_RESULT: "done in background" });
  const ws = makeTempDir();
  const job = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "long task", background: true, request: request() }, env);
  const { pid } = spawnBackgroundWorker(ws, job.id, env, { entryPath: ENTRY });
  assert.ok(pid > 0);
  assert.equal(await waitFor(() => getJob(ws, job.id, env).status === "succeeded"), true, "job should succeed");
  assert.equal(readJobFile(ws, job.id, env).result.result, "done in background");
  assert.ok(fs.existsSync(job.logFile));
  const snapshot = buildStatusSnapshot(ws, {}, env);
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.latestFinished.id, job.id);
  assert.equal(resolveJobForResult(ws, null, env).result.result, "done in background");
});

test("cancel kills a running background job", async () => {
  const env = envFor({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLEEP_MS: "20000" });
  const ws = makeTempDir();
  const job = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "forever", background: true, request: request() }, env);
  spawnBackgroundWorker(ws, job.id, env, { entryPath: ENTRY });
  assert.equal(await waitFor(() => getJob(ws, job.id, env).pid != null), true, "claude pid should be recorded");
  assert.equal(buildStatusSnapshot(ws, {}, env).running.length, 1);
  const report = cancelJob(ws, job.id, env);
  assert.equal(report.ok, true);
  assert.equal(getJob(ws, job.id, env).status, "cancelled");
  const claudePid = getJob(ws, job.id, env).pid;
  const gone = await waitFor(() => {
    try { process.kill(claudePid, 0); return false; } catch { return true; }
  }, 5000);
  assert.equal(gone, true, "claude process should be gone");
  assert.equal(cancelJob(ws, job.id, env).ok, false);
  assert.equal(cancelJob(ws, "job-missing", env).ok, false);
});
