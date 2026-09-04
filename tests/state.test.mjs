import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspaceRoot } from "../plugins/claude/scripts/lib/workspace.mjs";
import {
  resolveStateDir, loadState, upsertJob, listJobs, getJob, setLastSession, getLastSession,
  generateJobId, writeJobFile, readJobFile, resolveJobFile, MAX_JOBS
} from "../plugins/claude/scripts/lib/state.mjs";
import { makeTempDir, makeGitRepo, withStateDir, realpath } from "./helpers.mjs";

test("resolveWorkspaceRoot returns cwd outside git and repo root inside", () => {
  const plain = makeTempDir();
  assert.equal(realpath(resolveWorkspaceRoot(plain)), realpath(plain));
  const repo = makeTempDir();
  makeGitRepo(repo);
  const nested = path.join(repo, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(realpath(resolveWorkspaceRoot(nested)), realpath(repo));
});

test("state dir is derived from the env override, slug, and a 16-hex hash", () => {
  const env = withStateDir();
  const ws = path.join(makeTempDir(), "my repo");
  fs.mkdirSync(ws);
  const dir = resolveStateDir(ws, env);
  assert.ok(dir.startsWith(env.CLAUDE_COMPANION_STATE_DIR));
  assert.match(path.basename(dir), /^my-repo-[0-9a-f]{16}$/);
});

test("loadState returns defaults when nothing is stored", () => {
  const env = withStateDir();
  assert.deepEqual(loadState(makeTempDir(), env), { version: 1, lastSession: null, jobs: [] });
});

test("upsertJob creates then merges by id", () => {
  const env = withStateDir();
  const ws = makeTempDir();
  const created = upsertJob(ws, { id: "job-a", kind: "task", status: "queued" }, env);
  assert.equal(created.status, "queued");
  assert.ok(created.updatedAt);
  const updated = upsertJob(ws, { id: "job-a", status: "running", pid: 42 }, env);
  assert.equal(updated.kind, "task");
  assert.equal(updated.pid, 42);
  assert.equal(listJobs(ws, env).length, 1);
  assert.equal(getJob(ws, "job-a", env).status, "running");
  assert.equal(getJob(ws, "nope", env), null);
});

test("saveState keeps only the newest MAX_JOBS and deletes pruned files", () => {
  const env = withStateDir();
  const ws = makeTempDir();
  for (let i = 0; i < MAX_JOBS + 5; i += 1) {
    const id = `job-${String(i).padStart(3, "0")}`;
    upsertJob(ws, { id, kind: "task", status: "succeeded", updatedAt: new Date(1_000_000 + i * 1000).toISOString() }, env);
    writeJobFile(ws, id, { id }, env);
  }
  const jobs = listJobs(ws, env);
  assert.equal(jobs.length, MAX_JOBS);
  assert.equal(jobs.some((j) => j.id === "job-000"), false);
  assert.equal(fs.existsSync(resolveJobFile(ws, "job-000", env)), false);
  assert.equal(fs.existsSync(resolveJobFile(ws, `job-${String(MAX_JOBS + 4).padStart(3, "0")}`, env)), true);
});

test("last session round-trips", () => {
  const env = withStateDir();
  const ws = makeTempDir();
  assert.equal(getLastSession(ws, env), null);
  setLastSession(ws, { sessionId: "s-1", cwd: ws, promptExcerpt: "hello" }, env);
  const last = getLastSession(ws, env);
  assert.equal(last.sessionId, "s-1");
  assert.match(last.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("job files round-trip and generateJobId is unique-ish", () => {
  const env = withStateDir();
  const ws = makeTempDir();
  writeJobFile(ws, "job-x", { id: "job-x", request: { prompt: "p" } }, env);
  assert.deepEqual(readJobFile(ws, "job-x", env), { id: "job-x", request: { prompt: "p" } });
  assert.equal(readJobFile(ws, "missing", env), null);
  assert.match(generateJobId(), /^job-[0-9a-z]+-[0-9a-f]{4}$/);
  assert.notEqual(generateJobId(), generateJobId());
});

test("state and job files are written atomically with no temp files left behind", () => {
  const env = withStateDir();
  const ws = makeTempDir();
  upsertJob(ws, { id: "job-atomic", kind: "task", status: "queued" }, env);
  writeJobFile(ws, "job-atomic", { id: "job-atomic", request: { prompt: "p" } }, env);
  const dir = resolveStateDir(ws, env);
  const leftovers = fs.readdirSync(path.join(dir, "jobs")).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  assert.equal(readJobFile(ws, "job-atomic", env).request.prompt, "p");
});

test("finishJob never demotes a cancelled job and orphaned jobs are reconciled", async () => {
  const { finishJob } = await import("../plugins/claude/scripts/lib/state.mjs");
  const { reconcileOrphans, buildStatusSnapshot } = await import("../plugins/claude/scripts/lib/jobs.mjs");
  const env = withStateDir();
  const ws = makeTempDir();
  upsertJob(ws, { id: "job-c", kind: "task", status: "cancelled", error: "Cancelled by user." }, env);
  const kept = finishJob(ws, "job-c", { status: "succeeded", finishedAt: "2026-09-04T00:00:00.000Z", error: null }, env);
  assert.equal(kept.status, "cancelled");
  assert.equal(kept.error, "Cancelled by user.");
  upsertJob(ws, { id: "job-o", kind: "task", status: "running", pid: 999999, workerPid: 999998 }, env);
  assert.deepEqual(reconcileOrphans(ws, env), ["job-o"]);
  assert.equal(getJob(ws, "job-o", env).status, "failed");
  assert.match(getJob(ws, "job-o", env).error, /worker exited/);
  assert.equal(buildStatusSnapshot(ws, {}, env).running.length, 0);
});

test("concurrent processes updating the same workspace never lose a job", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const env = withStateDir();
  const ws = makeTempDir();
  const stateModule = fileURLToPath(new URL("../plugins/claude/scripts/lib/state.mjs", import.meta.url));
  const script = `import(${JSON.stringify(stateModule)}).then((m) => { for (let i = 0; i < 5; i += 1) m.upsertJob(process.argv[1], { id: process.argv[2] + "-" + i, kind: "task", status: "queued" }, process.env); });`;
  const children = Array.from({ length: 6 }, (_, index) =>
    new Promise((resolve) => spawn(process.execPath, ["--input-type=module", "-e", script, ws, `job-p${index}`], { env, stdio: "ignore" }).on("exit", resolve))
  );
  const codes = await Promise.all(children);
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
  assert.equal(listJobs(ws, env).length, 30);
});

test("transitionJob enforces the from-status and keeps state and job file consistent", async () => {
  const { transitionJob } = await import("../plugins/claude/scripts/lib/state.mjs");
  const env = withStateDir();
  const ws = makeTempDir();
  upsertJob(ws, { id: "job-t", kind: "task", status: "queued" }, env);
  writeJobFile(ws, "job-t", { id: "job-t", request: { prompt: "p" }, result: null }, env);
  const cancelled = transitionJob(ws, "job-t", { from: ["queued", "running"], patch: { status: "cancelled" }, fileMerge: {} }, env);
  assert.equal(cancelled.ok, true);
  const late = transitionJob(ws, "job-t", { from: ["running"], patch: { status: "succeeded" }, fileMerge: { result: { ok: true } } }, env);
  assert.equal(late.ok, false);
  assert.equal(late.reason, "cancelled");
  assert.equal(getJob(ws, "job-t", env).status, "cancelled");
  assert.equal(readJobFile(ws, "job-t", env).status, "cancelled");
  assert.equal(readJobFile(ws, "job-t", env).request.prompt, "p");
});
