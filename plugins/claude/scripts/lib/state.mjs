import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { sleepSync } from "./process.mjs";

export const STATE_DIR_ENV = "CLAUDE_COMPANION_STATE_DIR";
export const MAX_JOBS = 50;
const STATE_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;
const LOCK_POLL_MS = 20;
// Prompts are stored in these files; keep them private to the user where the OS supports modes.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

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

function tightenMode(target, mode) {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(target, mode);
  } catch {
    // best effort: unsupported filesystems keep their defaults
  }
}

export function ensureStateDir(workspaceRoot, env) {
  const dirs = [resolveStateRoot(env), resolveStateDir(workspaceRoot, env), resolveJobsDir(workspaceRoot, env)];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    tightenMode(dir, DIR_MODE);
  }
  // Correct files written by older versions that used the default umask. Only regular files:
  // never follow a symlink someone may have planted in the state directory.
  for (const file of [resolveStateFile(workspaceRoot, env), ...safeReaddir(resolveJobsDir(workspaceRoot, env))]) {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (stat.isFile()) tightenMode(file, FILE_MODE);
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

// Write through a temp file and rename so a concurrent reader never sees a half-written file.
function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode: FILE_MODE });
  fs.renameSync(tmp, file);
}

// A directory works as a cross-platform mutex: mkdir is atomic on every OS.
export function withStateLock(workspaceRoot, env, fn) {
  ensureStateDir(workspaceRoot, env);
  const lockDir = path.join(resolveStateDir(workspaceRoot, env), ".lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // lock vanished between the check and the stat; retry immediately
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the state lock at ${lockDir}.`);
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
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

function persistState(workspaceRoot, state, env) {
  const previous = loadState(workspaceRoot, env);
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
  writeFileAtomic(resolveStateFile(workspaceRoot, env), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function saveState(workspaceRoot, state, env) {
  return withStateLock(workspaceRoot, env, () => persistState(workspaceRoot, state, env));
}

// Read-modify-write under the lock, so concurrent companions never clobber each other.
export function updateState(workspaceRoot, mutate, env) {
  return withStateLock(workspaceRoot, env, () => {
    const state = loadState(workspaceRoot, env);
    mutate(state);
    return persistState(workspaceRoot, state, env);
  });
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

// Every status change goes through here: one lock covers the check of the current status, the
// state.json update, and the job-file merge, so state and job file can never disagree and a
// cancelled job can never be revived by a worker that finishes (or starts) late.
export function transitionJob(workspaceRoot, jobId, { from = null, patch = {}, fileMerge = null } = {}, env) {
  return withStateLock(workspaceRoot, env, () => {
    const state = loadState(workspaceRoot, env);
    const index = state.jobs.findIndex((entry) => entry.id === jobId);
    if (index === -1) return { ok: false, reason: "missing", job: null };
    const current = state.jobs[index];
    if (from && !from.includes(current.status)) return { ok: false, reason: current.status, job: current };
    const job = { ...current, ...patch, updatedAt: nowIso() };
    state.jobs[index] = job;
    if (fileMerge) {
      const stored = readJobFile(workspaceRoot, jobId, env) ?? {};
      writeFileAtomic(resolveJobFile(workspaceRoot, jobId, env), `${JSON.stringify({ ...stored, ...job, ...fileMerge }, null, 2)}\n`);
    }
    persistState(workspaceRoot, state, env);
    return { ok: true, reason: null, job };
  });
}

// Terminal transition that never demotes a cancelled job; returns the job as it stands afterwards.
export function finishJob(workspaceRoot, jobId, terminal, env) {
  const outcome = transitionJob(workspaceRoot, jobId, { from: ["queued", "running"], patch: terminal }, env);
  return outcome.job;
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
  writeFileAtomic(resolveJobFile(workspaceRoot, jobId, env), `${JSON.stringify(data, null, 2)}\n`);
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
