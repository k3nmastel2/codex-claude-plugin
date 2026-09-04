import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const STATE_DIR_ENV = "CLAUDE_COMPANION_STATE_DIR";
export const MAX_JOBS = 50;
const STATE_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return { version: STATE_VERSION, lastSession: null, jobs: [] };
}

export function resolveStateRoot(env = process.env) {
  if (env[STATE_DIR_ENV]) return path.resolve(env[STATE_DIR_ENV]);
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), ".codex");
  return path.join(codexHome, "claude-companion", "state");
}

export function resolveStateDir(workspaceRoot, env = process.env) {
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  const slug = (path.basename(workspaceRoot) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return path.join(resolveStateRoot(env), `${slug}-${hash}`);
}

export function resolveStateFile(workspaceRoot, env) {
  return path.join(resolveStateDir(workspaceRoot, env), "state.json");
}

export function resolveJobsDir(workspaceRoot, env) {
  return path.join(resolveStateDir(workspaceRoot, env), "jobs");
}

export function resolveJobFile(workspaceRoot, jobId, env) {
  return path.join(resolveJobsDir(workspaceRoot, env), `${jobId}.json`);
}

export function resolveJobLogFile(workspaceRoot, jobId, env) {
  return path.join(resolveJobsDir(workspaceRoot, env), `${jobId}.log`);
}

export function ensureStateDir(workspaceRoot, env) {
  fs.mkdirSync(resolveJobsDir(workspaceRoot, env), { recursive: true });
}

export function loadState(workspaceRoot, env) {
  const file = resolveStateFile(workspaceRoot, env);
  if (!fs.existsSync(file)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      lastSession: parsed.lastSession ?? null,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function removeIfExists(file) {
  if (file && fs.existsSync(file)) fs.rmSync(file, { force: true });
}

export function saveState(workspaceRoot, state, env) {
  const previous = loadState(workspaceRoot, env);
  ensureStateDir(workspaceRoot, env);
  const jobs = [...(state.jobs ?? [])]
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
  const kept = new Set(jobs.map((job) => job.id));
  for (const job of previous.jobs) {
    if (kept.has(job.id)) continue;
    removeIfExists(resolveJobFile(workspaceRoot, job.id, env));
    removeIfExists(resolveJobLogFile(workspaceRoot, job.id, env));
  }
  const next = { version: STATE_VERSION, lastSession: state.lastSession ?? null, jobs };
  fs.writeFileSync(resolveStateFile(workspaceRoot, env), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function updateState(workspaceRoot, mutate, env) {
  const state = loadState(workspaceRoot, env);
  mutate(state);
  return saveState(workspaceRoot, state, env);
}

export function upsertJob(workspaceRoot, patch, env) {
  if (!patch?.id) throw new Error("upsertJob requires an id.");
  let job = null;
  updateState(workspaceRoot, (state) => {
    const index = state.jobs.findIndex((entry) => entry.id === patch.id);
    const base = index === -1 ? { createdAt: nowIso() } : state.jobs[index];
    job = { ...base, ...patch, updatedAt: patch.updatedAt ?? nowIso() };
    if (index === -1) state.jobs.push(job);
    else state.jobs[index] = job;
  }, env);
  return job;
}

export function listJobs(workspaceRoot, env) {
  return loadState(workspaceRoot, env).jobs;
}

export function getJob(workspaceRoot, jobId, env) {
  return listJobs(workspaceRoot, env).find((job) => job.id === jobId) ?? null;
}

export function setLastSession(workspaceRoot, { sessionId, cwd, promptExcerpt }, env) {
  updateState(workspaceRoot, (state) => {
    state.lastSession = { sessionId, cwd, promptExcerpt: promptExcerpt ?? "", createdAt: nowIso() };
  }, env);
}

export function getLastSession(workspaceRoot, env) {
  return loadState(workspaceRoot, env).lastSession;
}

export function writeJobFile(workspaceRoot, jobId, data, env) {
  ensureStateDir(workspaceRoot, env);
  fs.writeFileSync(resolveJobFile(workspaceRoot, jobId, env), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function readJobFile(workspaceRoot, jobId, env) {
  const file = resolveJobFile(workspaceRoot, jobId, env);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function generateJobId(now = Date.now()) {
  return `job-${now.toString(36)}-${randomBytes(2).toString("hex")}`;
}
