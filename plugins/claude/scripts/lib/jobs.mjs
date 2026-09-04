import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { classifyFailure, parseResultEnvelope, runClaude } from "./claude.mjs";
import { describeProcess, isProcessAlive, terminateProcessTree } from "./process.mjs";
import {
  finishJob, generateJobId, getJob, listJobs, readJobFile, resolveJobLogFile, setLastSession, upsertJob, writeJobFile
} from "./state.mjs";

const ACTIVE = new Set(["queued", "running"]);
const OWN_PROCESS_PATTERN = /claude|claude-companion|node/i;

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
  upsertJob(workspaceRoot, { id: jobId, status: "running", startedAt: nowIso() }, env);

  const run = await runClaude({
    cwd: job.cwd,
    env,
    prompt: request.prompt,
    claudeArgs: request.claudeArgs,
    timeoutMs: request.timeoutMs ?? 0,
    onSpawn: (pid) => upsertJob(workspaceRoot, { id: jobId, pid }, env)
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
  // Persist the result before flipping the shared state to a terminal status, so anyone who
  // observes "succeeded" in state.json can immediately read the result file. finishJob keeps
  // a job that was cancelled in the meantime marked cancelled.
  writeJobFile(workspaceRoot, jobId, { ...stored, ...getJob(workspaceRoot, jobId, env), ...terminal, request, result: payload }, env);
  finishJob(workspaceRoot, jobId, terminal, env);
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

// Only signal PIDs that still look like ours; a recycled PID belonging to another program is skipped.
function terminateIfOurs(pid) {
  if (!pid) return { attempted: false, delivered: false, skipped: false };
  const description = describeProcess(pid);
  if (description === null) return { attempted: false, delivered: false, skipped: !isProcessAlive(pid) ? false : true };
  if (!OWN_PROCESS_PATTERN.test(description)) return { attempted: false, delivered: false, skipped: true };
  return { ...terminateProcessTree(pid), skipped: false };
}

export function cancelJob(workspaceRoot, jobId, env = process.env) {
  const job = getJob(workspaceRoot, jobId, env);
  if (!job) return { ok: false, job: null, message: `No job named ${jobId} in this workspace.` };
  if (!ACTIVE.has(job.status)) return { ok: false, job, message: `Job ${jobId} is already ${job.status}.` };
  // Mark first so a worker finishing concurrently cannot overwrite the cancellation.
  const updated = upsertJob(workspaceRoot, { id: jobId, status: "cancelled", finishedAt: nowIso(), error: "Cancelled by user." }, env);
  const reports = [job.pid, job.workerPid].map(terminateIfOurs);
  const stored = readJobFile(workspaceRoot, jobId, env);
  if (stored) writeJobFile(workspaceRoot, jobId, { ...stored, ...updated }, env);
  const delivered = reports.some((report) => report.delivered);
  const skipped = reports.some((report) => report.skipped);
  const message = delivered
    ? `Cancelled job ${jobId}.`
    : skipped
      ? `Marked job ${jobId} cancelled; a recorded process id no longer belongs to this job, so it was left alone.`
      : `Marked job ${jobId} cancelled; no live process was found.`;
  return { ok: true, job: updated, message };
}

// A worker that crashed (or was killed) leaves its job "running" forever; reconcile against live PIDs.
export function reconcileOrphans(workspaceRoot, env = process.env) {
  const orphans = listJobs(workspaceRoot, env).filter((job) =>
    ACTIVE.has(job.status) && (job.pid || job.workerPid) && !isProcessAlive(job.pid) && !isProcessAlive(job.workerPid)
  );
  for (const job of orphans) {
    finishJob(workspaceRoot, job.id, {
      status: "failed",
      finishedAt: nowIso(),
      error: "The worker exited without recording a result (crashed or was killed)."
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
