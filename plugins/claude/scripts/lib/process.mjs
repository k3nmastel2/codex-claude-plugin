import { spawnSync } from "node:child_process";
import process from "node:process";
import { splitRawArgumentString } from "./args.mjs";

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const KILL_GRACE_MS = 1500;
const KILL_POLL_MS = 100;

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    stdio: "pipe",
    timeout: options.timeoutMs,
    shell: options.shell ?? false,
    windowsHide: true
  });
  return {
    command,
    args,
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  // Never use a shell: libuv resolves bare names such as `git` via PATH and PATHEXT on Windows too.
  const useShell = options.shell ?? false;
  const result = runCommand(command, versionArgs, {
    cwd: options.cwd,
    env: options.env,
    shell: useShell,
    timeoutMs: 15000
  });
  if (result.error && result.error.code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    if (process.platform === "win32" && /not recognized|cannot find/i.test(detail)) {
      return { available: false, detail: "not found" };
    }
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

export function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Best-effort description of a live process, used before killing a PID recorded in a job
// file so that a recycled PID belonging to something else is left alone.
export function describeProcess(pid) {
  if (!isProcessAlive(pid)) return null;
  if (process.platform === "win32") {
    const result = runCommand("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    if (result.error || result.status !== 0) return null;
    const line = result.stdout.split(/\r?\n/).find((entry) => entry.includes(`"${pid}"`));
    return line ? line.split(",")[0].replace(/"/g, "") : null;
  }
  const result = runCommand("ps", ["-o", "command=", "-p", String(pid)]);
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { attempted: false, delivered: false, method: null };
  }
  const graceMs = options.graceMs ?? KILL_GRACE_MS;

  if (process.platform === "win32") {
    const result = runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill" };
    }
    try {
      process.kill(pid);
      return { attempted: true, delivered: true, method: "kill" };
    } catch {
      return { attempted: true, delivered: false, method: "kill" };
    }
  }

  const signalTree = (signal) => {
    try {
      process.kill(-pid, signal);
      return "process-group";
    } catch {
      try {
        process.kill(pid, signal);
        return "process";
      } catch {
        return null;
      }
    }
  };

  const method = signalTree("SIGTERM");
  if (!method) {
    return { attempted: true, delivered: false, method: "process" };
  }
  // Give the process a moment to exit cleanly, then escalate so a SIGTERM-ignoring child
  // cannot keep running unattended.
  const deadline = Date.now() + graceMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    sleepSync(KILL_POLL_MS);
  }
  if (isProcessAlive(pid)) {
    signalTree("SIGKILL");
    return { attempted: true, delivered: true, method: `${method}+SIGKILL` };
  }
  return { attempted: true, delivered: true, method };
}

export function resolveCommandSpec(spec) {
  const tokens = splitRawArgumentString(spec);
  if (tokens.length === 0) {
    throw new Error("Empty command specification.");
  }
  const [command, ...args] = tokens;
  return { command, args };
}
