import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { classifyFailure, parseResultEnvelope, runClaude } from "./claude.mjs";
import { describeProcess, isProcessAlive, terminateProcessTree } from "./process.mjs";
import {
  finishJob, generateJobId, getJob, listJobs, readJobFile, resolveJobLogFile, setLastSession, transitionJob, upsertJob, writeJobFile
} from "./state.mjs";

const ACTIVE = new Set(["queued", "running"]);
const QUEUED_ORPHAN_AGE_MS = 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

export function excerpt(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function tail(text, limit = 20) {
  return String(text ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-limit).join("\n");
}

export function createJob(workspaceRoot, { kind, cwd, promptExcerpt, background = false, request }, env = process.env) {
  const id = generateJobId();
  const job = upsertJob(workspaceRoot, {
    id,
    kind,
    status: "queued",
    pid: null,
    workerPid: null,
    cwd,
    promptExcerpt: excerpt(promptExcerpt),
    sessionId: null,
    logFile: resolveJobLogFile(workspaceRoot, id, env),
    finishedAt: null,
    exitCode: null,
    error: null,
    summary: null,
    background
  }, env);
  writeJobFile(workspaceRoot, id, { ...job, request, result: null }, env);
  return job;
}

export function buildPayload({ kind, cwd, jobId, run, envelope, failure, targetLabel = null }) {
  return {
    ok: !failure,
    command: kind,
    cwd,
    jobId,
    sessionId: envelope?.session_id ?? null,
    numTurns: envelope?.num_turns ?? null,
    costUsd: envelope?.total_cost_usd ?? null,
    durationMs: envelope?.duration_ms ?? null,
    result: failure ? "" : String(envelope?.result ?? ""),
    structuredOutput: envelope?.structured_output ?? null,
    permissionDenials: Array.isArray(envelope?.permission_denials) ? envelope.permission_denials : [],
    targetLabel,
    error: failure ?? null,
    stderr: tail(run?.stderr)
  };
}

export async function executeJob(workspaceRoot, jobId, env = process.env) {
  const stored = readJobFile(workspaceRoot, jobId, env);
  const job = getJob(workspaceRoot, jobId, env);
  if (!stored?.request || !job) {
    throw new Error(`Job ${jobId} has no stored request.`);
  }
  const { request } = stored;

  // Only a queued job may start; a job cancelled before its worker got here stays cancelled.
  const started = transitionJob(workspaceRoot, jobId, { from: ["queued"], patch: { status: "running", startedAt: nowIso() } }, env);
  if (!started.ok) {
    const reason = started.reason === "cancelled" ? "Job was cancelled before it started." : `Job is already ${started.reason}.`;
    return buildPayload({ kind: job.kind, cwd: job.cwd, jobId, run: null, envelope: null, failure: { kind: started.reason, message: reason }, targetLabel: request.targetLabel ?? null });
  }

  const run = await runClaude({
    cwd: job.cwd,
    env,
    prompt: request.prompt,
    claudeArgs: request.claudeArgs,
    timeoutMs: request.timeoutMs ?? 0,
    // Record the child unconditionally; if a cancel landed between "running" and this point,
    // take the child down right here so it cannot outlive the cancellation.
    onSpawn: (pid) => {
      const recorded = transitionJob(workspaceRoot, jobId, { patch: { pid } }, env);
      if (recorded.job?.status === "cancelled") terminateProcessTree(pid, { graceMs: 300 });
    }
  });

  const { envelope } = parseResultEnvelope(run.stdout);
  const failure = classifyFailure({ ...run, envelope, timeoutMs: request.timeoutMs });
  const payload = buildPayload({ kind: job.kind, cwd: job.cwd, jobId, run, envelope, failure, targetLabel: request.targetLabel ?? null });

  if (!failure && job.kind === "task" && payload.sessionId) {
    setLastSession(workspaceRoot, { sessionId: payload.sessionId, cwd: job.cwd, promptExcerpt: job.promptExcerpt }, env);
  }

  const summary = failure ? failure.message.split(/\r?\n/)[0] : excerpt(payload.structuredOutput?.summary ?? payload.result, 120);
  const terminal = {
    status: failure ? "failed" : "succeeded",
    finishedAt: nowIso(),
    exitCode: run.status,
    sessionId: payload.sessionId,
    error: failure ? failure.message : null,
    summary
  };
  // One locked transition writes the result file and flips the status together. If the job was
  // cancelled while Claude ran, the status stays cancelled and the result is only attached.
  const finished = transitionJob(workspaceRoot, jobId, { from: ["running"], patch: terminal, fileMerge: { request, result: payload } }, env);
  if (!finished.ok) {
    transitionJob(workspaceRoot, jobId, { patch: { exitCode: run.status, sessionId: payload.sessionId }, fileMerge: { request, result: payload } }, env);
  }
  return payload;
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

export function spawnBackgroundWorker(workspaceRoot, jobId, env = process.env, { entryPath }) {
  const job = getJob(workspaceRoot, jobId, env);
  if (!job) throw new Error(`Unknown job ${jobId}.`);
  const logFd = fs.openSync(job.logFile, "a", 0o600);
  const child = spawn(process.execPath, [entryPath, "__worker", jobId, "--cwd", workspaceRoot], {
    cwd: job.cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true
  });
  child.unref();
  fs.closeSync(logFd);
  upsertJob(workspaceRoot, { id: jobId, workerPid: child.pid }, env);
  return { pid: child.pid };
}

// A recorded PID is only signalled when the live process still looks like this job's own:
// the worker carries "__worker <job id>" on its command line, the Claude child carries "-p" or the
// companion's session name. Windows only exposes image names, so it checks those.
export function processBelongsToJob(pid, role, jobId, description = describeProcess(pid)) {
  if (description === null) return false;
  if (process.platform === "win32") return /node|claude/i.test(description);
  if (role === "worker") return new RegExp(`__worker\\s+${jobId}(\\s|$)`).test(description);
  return /claude/i.test(description) && /(^|\s)-p(\s|$)|Codex → Claude/.test(description);
}

function terminateIfOurs(pid, role, jobId) {
  if (!pid) return { attempted: false, delivered: false, skipped: false };
  if (!isProcessAlive(pid)) return { attempted: false, delivered: false, skipped: false };
  if (!processBelongsToJob(pid, role, jobId)) return { attempted: false, delivered: false, skipped: true };
  return { ...terminateProcessTree(pid), skipped: false };
}

export function cancelJob(workspaceRoot, jobId, env = process.env) {
  const existing = getJob(workspaceRoot, jobId, env);
  if (!existing) return { ok: false, job: null, message: `No job named ${jobId} in this workspace.` };
  // Record the cancellation first, under the lock, so a worker finishing concurrently cannot overwrite it.
  const outcome = transitionJob(workspaceRoot, jobId, {
    from: [...ACTIVE],
    patch: { status: "cancelled", finishedAt: nowIso(), error: "Cancelled by user." },
    fileMerge: {}
  }, env);
  if (!outcome.ok) return { ok: false, job: outcome.job, message: `Job ${jobId} is already ${outcome.reason}.` };
  // Signal the PIDs as they stood under the lock, not the snapshot read before it.
  const reports = [terminateIfOurs(outcome.job.pid, "claude", jobId), terminateIfOurs(outcome.job.workerPid, "worker", jobId)];
  const delivered = reports.some((report) => report.delivered);
  const skipped = reports.some((report) => report.skipped);
  const message = delivered
    ? `Cancelled job ${jobId}.`
    : skipped
      ? `Marked job ${jobId} cancelled; a recorded process id no longer belongs to this job, so it was left alone.`
      : `Marked job ${jobId} cancelled; no live process was found.`;
  return { ok: true, job: outcome.job, message };
}

// A worker that crashed (or was killed) leaves its job active forever; reconcile against live PIDs.
// A queued job whose worker never checked in within a minute is treated the same way.
export function reconcileOrphans(workspaceRoot, env = process.env, now = Date.now()) {
  const orphans = listJobs(workspaceRoot, env).filter((job) => {
    if (!ACTIVE.has(job.status)) return false;
    const anyAlive = isProcessAlive(job.pid) || isProcessAlive(job.workerPid);
    if (anyAlive) return false;
    if (job.pid || job.workerPid) return true;
    return job.status === "queued" && now - Date.parse(job.createdAt ?? "") > QUEUED_ORPHAN_AGE_MS;
  });
  for (const job of orphans) {
    finishJob(workspaceRoot, job.id, {
      status: "failed",
      finishedAt: nowIso(),
      error: "The worker exited without recording a result (crashed, was killed, or never started)."
    }, env);
  }
  return orphans.map((job) => job.id);
}

export function buildStatusSnapshot(workspaceRoot, { all = false } = {}, env = process.env) {
  reconcileOrphans(workspaceRoot, env);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot, env));
  const running = jobs.filter((job) => ACTIVE.has(job.status));
  const finished = jobs.filter((job) => !ACTIVE.has(job.status));
  return {
    running,
    latestFinished: finished[0] ?? null,
    recent: all ? finished : finished.slice(0, 10)
  };
}

export function resolveJobForResult(workspaceRoot, jobId, env = process.env) {
  const job = jobId ? getJob(workspaceRoot, jobId, env) : buildStatusSnapshot(workspaceRoot, {}, env).latestFinished;
  if (!job) return null;
  const stored = readJobFile(workspaceRoot, job.id, env);
  return { job, result: stored?.result ?? null };
}
