import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildChildEnv } from "./env.mjs";
import { binaryAvailable, resolveCommandSpec, runCommand, terminateProcessTree } from "./process.mjs";

export const CLAUDE_CMD_ENV = "CLAUDE_COMPANION_CLAUDE_CMD";
export const PROMPT_VIA_ARGV_ENV = "CLAUDE_COMPANION_PROMPT_VIA_ARGV";
export const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const READ_ONLY_DISALLOWED = "Edit,Write,MultiEdit,NotebookEdit";
const PERMISSION_LEVELS = new Set(["read", "write", "full"]);
const AUTH_PATTERN = /authenticat|oauth|not logged in|log in|login|api key|credential/i;

export function resolveWindowsClaude(whereOutput, existsSync = fs.existsSync) {
  const candidates = String(whereOutput ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const exe = candidates.find((candidate) => candidate.toLowerCase().endsWith(".exe"));
  if (exe) return { command: exe, args: [], shell: false };
  const cmd = candidates.find((candidate) => candidate.toLowerCase().endsWith(".cmd"));
  if (cmd) {
    const cliJs = path.win32.join(path.win32.dirname(cmd), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(cliJs)) return { command: process.execPath, args: [cliJs], shell: false };
    return { command: cmd, args: [], shell: true };
  }
  return null;
}

export function resolveClaudeCommand(env = process.env, options = {}) {
  if (env[CLAUDE_CMD_ENV]) {
    return { ...resolveCommandSpec(env[CLAUDE_CMD_ENV]), shell: false };
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command: "claude", args: [], shell: false };
  }
  const where = options.where ?? (() => runCommand("where.exe", ["claude"], { env }).stdout);
  return resolveWindowsClaude(where()) ?? { command: "claude", args: [], shell: true };
}

export function buildClaudeArgs(options = {}) {
  const permission = options.permission ?? "read";
  if (!PERMISSION_LEVELS.has(permission)) {
    throw new Error(`Unsupported permission level "${permission}". Use read, write, or full.`);
  }
  if (options.effort != null && !VALID_EFFORTS.includes(options.effort)) {
    throw new Error(`Unsupported effort "${options.effort}". Use one of: ${VALID_EFFORTS.join(", ")}.`);
  }
  const args = ["-p", "--output-format", "json"];
  if (permission === "read") args.push("--permission-mode", "dontAsk", "--disallowedTools", READ_ONLY_DISALLOWED);
  if (permission === "write") args.push("--permission-mode", "acceptEdits");
  if (permission === "full") args.push("--dangerously-skip-permissions");
  if (options.allow?.length) args.push("--allowedTools", options.allow.join(","));
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.maxTurns != null) args.push("--max-turns", String(options.maxTurns));
  if (options.maxBudgetUsd != null) args.push("--max-budget-usd", String(options.maxBudgetUsd));
  for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);
  if (options.name) args.push("--name", options.name);
  if (options.appendSystemPrompt) args.push("--append-system-prompt", options.appendSystemPrompt);
  if (options.jsonSchema) args.push("--json-schema", options.jsonSchema);
  if (options.promptViaArgv != null) args.push(options.promptViaArgv);
  return args;
}

export function parseResultEnvelope(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object" && parsed.type === "result") return { envelope: parsed, error: null };
    } catch {
      // not JSON, keep scanning upward
    }
  }
  try {
    const whole = JSON.parse(String(stdout ?? "").trim());
    if (whole && typeof whole === "object" && whole.type === "result") return { envelope: whole, error: null };
  } catch {
    // fall through
  }
  return { envelope: null, error: "Claude produced no JSON result envelope." };
}

function tail(text, limit = 20) {
  return String(text ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-limit).join("\n");
}

export function classifyFailure(run = {}) {
  if (run.error?.code === "ENOENT") {
    return { kind: "missing", message: "The claude CLI was not found on PATH. Install Claude Code, then run `claude auth login`. See https://docs.claude.com/en/docs/claude-code/setup" };
  }
  if (run.error) {
    return { kind: "exit", message: `Could not start claude: ${run.error.message}` };
  }
  if (run.timedOut) {
    return { kind: "timeout", message: `Claude did not finish within ${run.timeoutMs ?? "the configured"} ms. Re-run with --background or a larger --timeout-ms.` };
  }
  const envelope = run.envelope ?? null;
  if (envelope?.is_error) {
    const detail = String(envelope.result ?? "").trim() || "unknown error";
    if (AUTH_PATTERN.test(detail)) {
      return { kind: "auth", message: `Claude is not logged in (${detail}). Run \`claude auth login\` in your own terminal, then retry.` };
    }
    return { kind: "api", message: `Claude reported an error: ${detail}` };
  }
  if (!envelope) {
    if (run.status !== 0 && run.status != null) {
      // stderr is rendered separately by the caller; only fall back to stdout here.
      const detail = tail(run.stderr) ? "" : tail(run.stdout);
      return { kind: "exit", message: `claude exited with code ${run.status}${run.signal ? ` (${run.signal})` : ""}.${detail ? `\n${detail}` : ""}` };
    }
    return { kind: "parse", message: `Claude produced no JSON result envelope.${tail(run.stdout) ? `\n${tail(run.stdout)}` : ""}` };
  }
  if (run.status !== 0 && run.status != null) {
    return { kind: "exit", message: `claude exited with code ${run.status} after producing a result.${tail(run.stderr) ? `\n${tail(run.stderr)}` : ""}` };
  }
  return null;
}

export function runClaude({ cwd, env = process.env, prompt, claudeArgs, timeoutMs = 0, onSpawn = null }) {
  const resolved = resolveClaudeCommand(env);
  const viaArgv = String(env[PROMPT_VIA_ARGV_ENV] ?? "") === "1";
  const args = [...resolved.args, ...claudeArgs, ...(viaArgv ? [prompt] : [])];
  const childEnv = buildChildEnv(env);
  const detached = process.platform !== "win32";

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer = null;
    let child;
    let cleanup = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (cleanup) {
        process.off("SIGINT", cleanup);
        process.off("SIGTERM", cleanup);
        process.off("exit", cleanup);
      }
      resolve({ pid: child?.pid ?? null, stdout, stderr, timedOut, ...payload });
    };
    try {
      child = spawn(resolved.command, args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], shell: resolved.shell, windowsHide: true, detached });
    } catch (error) {
      finish({ status: null, signal: null, error });
      return;
    }
    // If Codex kills the companion (shell timeout, user abort), take Claude down with it
    // so a --write or --full run never continues unattended.
    cleanup = () => terminateProcessTree(child.pid);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    process.once("exit", cleanup);
    onSpawn?.(child.pid);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child.pid);
      }, timeoutMs);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ status: null, signal: null, error }));
    child.on("close", (status, signal) => finish({ status, signal, error: null }));
    child.stdin.on("error", () => {});
    if (viaArgv) child.stdin.end();
    else child.stdin.end(prompt);
  });
}

export function getClaudeAvailability(env = process.env) {
  const resolved = resolveClaudeCommand(env);
  return binaryAvailable(resolved.command, [...resolved.args, "--version"], { env });
}

export function getClaudeAuthStatus(env = process.env) {
  const resolved = resolveClaudeCommand(env);
  const result = runCommand(resolved.command, [...resolved.args, "auth", "status"], { env, shell: resolved.shell, timeoutMs: 15000 });
  if (result.error) {
    return { loggedIn: false, detail: result.error.code === "ENOENT" ? "claude not found" : result.error.message };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    if (typeof parsed.loggedIn === "boolean") {
      return { loggedIn: parsed.loggedIn, detail: parsed.loggedIn ? `logged in (${parsed.authMethod ?? "unknown"})` : "not logged in" };
    }
  } catch {
    // fall back to the exit code
  }
  return { loggedIn: result.status === 0, detail: result.status === 0 ? "logged in" : (result.stderr.trim() || result.stdout.trim() || "not logged in") };
}
