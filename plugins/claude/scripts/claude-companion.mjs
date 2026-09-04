#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { buildClaudeArgs, getClaudeAuthStatus, getClaudeAvailability, INSTALL_HINT } from "./lib/claude.mjs";
import { detectNesting, detectSandbox } from "./lib/env.mjs";
import { collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import {
  buildStatusSnapshot, cancelJob, createJob, excerpt, executeJob, resolveJobForResult, spawnBackgroundWorker
} from "./lib/jobs.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import { buildReviewPrompt, loadCodexContext } from "./lib/prompts.mjs";
import {
  renderBackgroundLaunch, renderCancelReport, renderFailure, renderJobResult, renderReviewResult, renderSetupReport,
  renderStatusReport, renderTaskResult
} from "./lib/render.mjs";
import { getJob, getLastSession } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ENTRY_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(ENTRY_PATH), "..");
const REVIEW_SCHEMA_PATH = path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json");
const DEFAULT_FOREGROUND_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_BACKGROUND_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MIN_NODE_MAJOR = 20;
const USAGE = [
  "Usage: node claude-companion.mjs <command> [options]",
  "  setup [--json]",
  "  task [--write|--full] [--allow <rule>]... [--resume|--fresh] [--model <m>] [--effort <low|medium|high|xhigh|max>]",
  "       [--max-turns <n>] [--max-budget-usd <x>] [--add-dir <dir>]... [--timeout-ms <n>] [--background] [--allow-nested] [--json] [--] <prompt|->",
  "  review [--adversarial] [--base <ref>] [--scope auto|working-tree|branch] [--timeout-ms <n>] [--background] [--allow-nested] [--json] [focus...]",
  "  status [job-id] [--all] [--json]",
  "  result [job-id] [--json]",
  "  cancel [job-id] [--json]",
  "  resume-candidate [--json]",
  "",
  "Flags must be separate arguments; a single argument is always treated as literal text."
].join("\n");

const PARSE_CONFIG = {
  valueOptions: ["cwd", "model", "effort", "max-turns", "max-budget-usd", "timeout-ms", "base", "scope"],
  booleanOptions: ["json", "write", "full", "resume", "fresh", "background", "adversarial", "all", "allow-nested"],
  repeatableOptions: ["allow", "add-dir"],
  aliasMap: { C: "cwd" }
};

class UsageError extends Error {}

// Never re-tokenise argv: a prompt that happens to start with "--full" must stay a prompt.
function parse(argv) {
  return parseArgs(argv, PARSE_CONFIG);
}

function resolveContext(options) {
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  return { cwd, workspaceRoot: resolveWorkspaceRoot(cwd), env: process.env };
}

function emit(asJson, payload, text) {
  process.stdout.write(asJson ? `${JSON.stringify(payload, null, 2)}\n` : text);
}

function emitFailure(asJson, payload) {
  emit(asJson, payload, renderFailure(payload));
  process.exitCode = 1;
}

function failurePayload(kind, message, extra = {}) {
  return { ok: false, error: { kind, message }, stderr: "", ...extra };
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function parseIntegerOption(value, name) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`--${name} must be a non-negative integer.`);
  return parsed;
}

function parseNumberOption(value, name) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`--${name} must be a non-negative number.`);
  return parsed;
}

function guardEnvironment(env, options, asJson) {
  const nesting = detectNesting(env, { allowNested: Boolean(options["allow-nested"]) });
  if (nesting.nested) {
    const hint = options["allow-nested"] ? ` Raise ${"CLAUDE_COMPANION_MAX_DEPTH"} to allow deeper chains.` : " Pass --allow-nested to override.";
    emitFailure(asJson, failurePayload("nested", `${nesting.reason}${hint}`));
    return false;
  }
  const sandbox = detectSandbox(env);
  if (sandbox.networkDisabled) {
    emitFailure(asJson, failurePayload("sandbox", sandbox.reason));
    return false;
  }
  return true;
}

async function runOrLaunch({ workspaceRoot, env, asJson, kind, cwd, promptExcerpt, request, background, render }) {
  const job = createJob(workspaceRoot, { kind, cwd, promptExcerpt, background, request }, env);
  if (background) {
    spawnBackgroundWorker(workspaceRoot, job.id, env, { entryPath: ENTRY_PATH });
    emit(asJson, { ok: true, background: true, job: getJob(workspaceRoot, job.id, env) }, renderBackgroundLaunch(job));
    return;
  }
  const payload = await executeJob(workspaceRoot, job.id, env);
  if (!payload.ok) {
    emitFailure(asJson, payload);
    return;
  }
  emit(asJson, payload, render(payload));
}

function nodeStatus() {
  const version = process.versions.node;
  const major = Number.parseInt(version.split(".")[0], 10);
  return major >= MIN_NODE_MAJOR
    ? { available: true, detail: `v${version}` }
    : { available: false, detail: `v${version} is older than the required Node ${MIN_NODE_MAJOR}` };
}

async function commandSetup(argv) {
  const { options } = parse(argv);
  const { cwd, env } = resolveContext(options);
  const node = nodeStatus();
  const git = binaryAvailable("git", ["--version"], { env });
  const claude = getClaudeAvailability(env);
  const auth = claude.available ? getClaudeAuthStatus(env) : { loggedIn: false, detail: "claude not found" };
  const nesting = detectNesting(env);
  const sandbox = detectSandbox(env);
  const nextSteps = [];
  if (!node.available) nextSteps.push(`Install Node.js ${MIN_NODE_MAJOR} or newer from https://nodejs.org and open a new terminal.`);
  if (!git.available) nextSteps.push("Install git (reviews and workspace detection need it): https://git-scm.com/downloads");
  if (!claude.available) {
    nextSteps.push(INSTALL_HINT);
  } else if (!auth.loggedIn) {
    nextSteps.push("Run `claude auth login` in your own terminal (or export ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN), then re-run setup.");
  }
  if (nesting.nested) nextSteps.push(`Nesting guard is active: ${nesting.reason}`);
  if (sandbox.networkDisabled) nextSteps.push(sandbox.reason);
  const ready = node.available && git.available && claude.available && auth.loggedIn && !nesting.nested && !sandbox.networkDisabled;
  const report = { ready, cwd, node, git, claude, auth, nesting, sandbox, nextSteps };
  emit(Boolean(options.json), report, renderSetupReport(report));
  if (!report.ready) process.exitCode = 1;
}

async function commandTask(argv) {
  const { options, positionals } = parse(argv);
  const asJson = Boolean(options.json);
  const { cwd, workspaceRoot, env } = resolveContext(options);
  if (!guardEnvironment(env, options, asJson)) return;

  let prompt = positionals.join(" ").trim();
  if (prompt === "-" || !prompt) prompt = (await readStdin()).trim();
  if (!prompt) throw new UsageError("task needs a prompt (as arguments, or `-` to read stdin).");

  let resumeSessionId = null;
  if (options.resume && !options.fresh) {
    const last = getLastSession(workspaceRoot, env);
    if (!last?.sessionId) {
      emitFailure(asJson, failurePayload("resume", "No previous Claude session is recorded for this workspace. Run without --resume to start a new one."));
      return;
    }
    resumeSessionId = last.sessionId;
  }

  const permission = options.full ? "full" : options.write ? "write" : "read";
  const claudeArgs = buildClaudeArgs({
    permission,
    claudeVersion: getClaudeAvailability(env).detail,
    allow: options.allow ?? [],
    resumeSessionId,
    model: options.model ?? null,
    effort: options.effort ?? null,
    maxTurns: parseIntegerOption(options["max-turns"], "max-turns"),
    maxBudgetUsd: parseNumberOption(options["max-budget-usd"], "max-budget-usd"),
    addDirs: options["add-dir"] ?? [],
    name: `Codex → Claude: ${excerpt(prompt, 56)}`,
    appendSystemPrompt: loadCodexContext(PLUGIN_ROOT)
  });
  const background = Boolean(options.background);
  const timeoutMs = parseIntegerOption(options["timeout-ms"], "timeout-ms") ?? (background ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_FOREGROUND_TIMEOUT_MS);

  await runOrLaunch({
    workspaceRoot, env, asJson, kind: "task", cwd, promptExcerpt: prompt, background,
    request: { prompt, claudeArgs, timeoutMs, structured: false, targetLabel: null },
    render: renderTaskResult
  });
}

async function commandReview(argv) {
  const { options, positionals } = parse(argv);
  const asJson = Boolean(options.json);
  const { cwd, workspaceRoot, env } = resolveContext(options);
  if (!guardEnvironment(env, options, asJson)) return;

  let target;
  let context;
  try {
    target = resolveReviewTarget(cwd, { scope: options.scope ?? "auto", base: options.base ?? null });
    context = collectReviewContext(cwd, target);
  } catch (error) {
    emitFailure(asJson, failurePayload("git", error.message));
    return;
  }
  const focus = positionals.join(" ").trim();
  const prompt = buildReviewPrompt(PLUGIN_ROOT, { adversarial: Boolean(options.adversarial), targetLabel: target.label, focus, context: context.text });
  // Claude's --json-schema validator rejects an explicit 2020-12 "$schema" meta-schema URI, so never send one.
  const { $schema: _metaSchema, ...schemaBody } = JSON.parse(fs.readFileSync(REVIEW_SCHEMA_PATH, "utf8"));
  const schema = JSON.stringify(schemaBody);
  const claudeArgs = buildClaudeArgs({
    permission: "read",
    claudeVersion: getClaudeAvailability(env).detail,
    model: options.model ?? null,
    effort: options.effort ?? null,
    name: `Codex → Claude review: ${target.label}`,
    appendSystemPrompt: loadCodexContext(PLUGIN_ROOT),
    jsonSchema: schema
  });
  const background = Boolean(options.background);
  const timeoutMs = parseIntegerOption(options["timeout-ms"], "timeout-ms") ?? (background ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_FOREGROUND_TIMEOUT_MS);

  await runOrLaunch({
    workspaceRoot, env, asJson, kind: "review", cwd, background,
    promptExcerpt: `${options.adversarial ? "adversarial " : ""}review of ${target.label}${focus ? `: ${focus}` : ""}`,
    request: { prompt, claudeArgs, timeoutMs, structured: true, targetLabel: target.label },
    render: renderReviewResult
  });
}

async function commandStatus(argv) {
  const { options, positionals } = parse(argv);
  const { workspaceRoot, env } = resolveContext(options);
  const [jobId] = positionals;
  if (jobId) {
    buildStatusSnapshot(workspaceRoot, {}, env);
    const job = getJob(workspaceRoot, jobId, env);
    if (!job) {
      emitFailure(Boolean(options.json), failurePayload("job", `No job named ${jobId} in this workspace.`));
      return;
    }
    const active = job.status === "running" || job.status === "queued";
    emit(Boolean(options.json), { ok: true, job }, renderStatusReport({ running: active ? [job] : [], latestFinished: active ? null : job, recent: [] }));
    return;
  }
  const snapshot = buildStatusSnapshot(workspaceRoot, { all: Boolean(options.all) }, env);
  emit(Boolean(options.json), { ok: true, ...snapshot }, renderStatusReport(snapshot));
}

async function commandResult(argv) {
  const { options, positionals } = parse(argv);
  const { workspaceRoot, env } = resolveContext(options);
  const [jobId] = positionals;
  if (jobId && !getJob(workspaceRoot, jobId, env)) {
    emitFailure(Boolean(options.json), failurePayload("job", `No job named ${jobId} in this workspace.`));
    return;
  }
  const resolved = resolveJobForResult(workspaceRoot, jobId ?? null, env);
  if (!resolved) {
    emitFailure(Boolean(options.json), failurePayload("job", "No finished jobs recorded for this workspace yet."));
    return;
  }
  emit(Boolean(options.json), { ok: true, ...resolved }, renderJobResult(resolved));
  if (resolved.result && !resolved.result.ok) process.exitCode = 1;
}

async function commandCancel(argv) {
  const { options, positionals } = parse(argv);
  const { workspaceRoot, env } = resolveContext(options);
  const jobId = positionals[0] ?? buildStatusSnapshot(workspaceRoot, {}, env).running[0]?.id ?? null;
  if (!jobId) {
    emitFailure(Boolean(options.json), failurePayload("job", "No running job to cancel."));
    return;
  }
  const report = cancelJob(workspaceRoot, jobId, env);
  emit(Boolean(options.json), report, renderCancelReport(report));
  if (!report.ok) process.exitCode = 1;
}

async function commandResumeCandidate(argv) {
  const { options } = parse(argv);
  const { workspaceRoot, env } = resolveContext(options);
  const last = getLastSession(workspaceRoot, env);
  const payload = last?.sessionId
    ? { available: true, sessionId: last.sessionId, createdAt: last.createdAt, promptExcerpt: last.promptExcerpt }
    : { available: false, sessionId: null, createdAt: null, promptExcerpt: null };
  emit(true, payload, "");
}

async function runWorker(argv) {
  const { options, positionals } = parseArgs(argv, { valueOptions: ["cwd"], aliasMap: { C: "cwd" } });
  const [jobId] = positionals;
  if (!jobId) throw new UsageError("Usage: claude-companion.mjs __worker <job-id> --cwd <workspace-root>");
  const workspaceRoot = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const payload = await executeJob(workspaceRoot, jobId, process.env);
  process.exitCode = payload.ok ? 0 : 1;
}

const COMMANDS = {
  setup: commandSetup,
  task: commandTask,
  review: commandReview,
  status: commandStatus,
  result: commandResult,
  cancel: commandCancel,
  "resume-candidate": commandResumeCandidate,
  __worker: runWorker
};

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const handler = COMMANDS[command];
  if (!handler) throw new UsageError(`Unknown command "${command ?? ""}".\n${USAGE}`);
  await handler(argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${message}\n`);
  process.exitCode = 1;
});
