import { spawnSync } from "node:child_process";
import process from "node:process";
import { splitRawArgumentString } from "./args.mjs";

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

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
  // A shell is needed on Windows only to resolve bare names such as `claude` to claude.cmd.
  // Absolute paths (which may contain spaces) are spawned directly so they need no quoting.
  const useShell = options.shell ?? (process.platform === "win32" && !/[\\/]/.test(command));
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

export function terminateProcessTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { attempted: false, delivered: false, method: null };
  }
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
  try {
    process.kill(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch {
      return { attempted: true, delivered: false, method: "process" };
    }
  }
}

export function resolveCommandSpec(spec) {
  const tokens = splitRawArgumentString(spec);
  if (tokens.length === 0) {
    throw new Error("Empty command specification.");
  }
  const [command, ...args] = tokens;
  return { command, args };
}
