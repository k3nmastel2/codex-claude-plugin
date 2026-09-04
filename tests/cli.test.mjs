import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { runCommand } from "../plugins/claude/scripts/lib/process.mjs";
import { readJobFile, listJobs } from "../plugins/claude/scripts/lib/state.mjs";
import { ENTRY, FAKE_CLAUDE_CMD, cleanEnv, makeTempDir, makeGitRepo, withStateDir } from "./helpers.mjs";

const envFor = (extra = {}) => withStateDir({ CLAUDE_COMPANION_CLAUDE_CMD: FAKE_CLAUDE_CMD, ...extra });
const cli = (cwd, env, args, input) => runCommand(process.execPath, [ENTRY, ...args], { cwd, env, input });
const json = (result) => JSON.parse(result.stdout);

async function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("setup reports readiness and next steps", () => {
  const ready = cli(makeTempDir(), envFor(), ["setup", "--json"]);
  assert.equal(ready.status, 0);
  assert.equal(json(ready).ready, true);
  const loggedOut = cli(makeTempDir(), envFor({ FAKE_CLAUDE_LOGGED_IN: "false" }), ["setup"]);
  assert.equal(loggedOut.status, 1);
  assert.match(loggedOut.stdout, /Ready: no/);
  assert.match(loggedOut.stdout, /claude auth login/);
  const missing = cli(makeTempDir(), { ...cleanEnv(), CLAUDE_COMPANION_CLAUDE_CMD: "definitely-not-a-binary-xyz", CLAUDE_COMPANION_STATE_DIR: makeTempDir() }, ["setup"]);
  assert.match(missing.stdout, /Install Claude Code/);
});

test("task prints the answer and trailer, records the job, and stores the request", () => {
  const env = envFor({ FAKE_CLAUDE_RESULT: "It starts in login.ts." });
  const cwd = makeTempDir();
  const result = cli(cwd, env, ["task", "explain", "the", "auth", "flow"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith("It starts in login.ts.\n\n"));
  assert.match(result.stdout, /claude session 11111111-1111-4111-8111-111111111111/);
  const [job] = listJobs(cwd, env);
  assert.equal(job.status, "succeeded");
  const request = readJobFile(cwd, job.id, env).request;
  assert.equal(request.prompt, "explain the auth flow");
  assert.ok(request.claudeArgs.includes("dontAsk"));
  assert.ok(request.claudeArgs.includes("--append-system-prompt"));
  assert.ok(request.claudeArgs.some((arg) => arg.startsWith("Codex → Claude: explain the auth")));
});

test("task honours a raw argument string, --write, --full, --allow, --model, --effort", () => {
  const env = envFor();
  const cwd = makeTempDir();
  assert.equal(cli(cwd, env, ["task", '--write --model opus --effort high --allow "Bash(npm test:*)" fix the bug']).status, 0);
  const write = readJobFile(cwd, listJobs(cwd, env)[0].id, env).request;
  assert.equal(write.prompt, "fix the bug");
  assert.ok(write.claudeArgs.includes("acceptEdits"));
  assert.ok(write.claudeArgs.includes("Bash(npm test:*)"));
  assert.ok(write.claudeArgs.includes("opus") && write.claudeArgs.includes("high"));
  assert.equal(cli(cwd, env, ["task", "--full", "--", "--looks-like-a-flag"]).status, 0);
  const full = readJobFile(cwd, listJobs(cwd, env)[0].id, env).request;
  assert.ok(full.claudeArgs.includes("--dangerously-skip-permissions"));
  assert.equal(full.prompt, "--looks-like-a-flag");
});

test("task reads the prompt from stdin with -", () => {
  const result = cli(makeTempDir(), envFor(), ["task", "--json", "-"], "piped prompt here");
  assert.equal(result.status, 0);
  assert.match(json(result).result, /piped prompt here/);
});

test("task refuses nesting unless --allow-nested", () => {
  const nested = cli(makeTempDir(), envFor({ CLAUDECODE: "1" }), ["task", "hi"]);
  assert.equal(nested.status, 1);
  assert.match(nested.stdout, /Claude Code session/);
  assert.equal(cli(makeTempDir(), envFor({ CLAUDECODE: "1" }), ["task", "--allow-nested", "hi"]).status, 0);
});

test("resume-candidate and --resume", () => {
  const env = envFor({ FAKE_CLAUDE_SESSION_ID: "sess-9" });
  const cwd = makeTempDir();
  assert.equal(json(cli(cwd, env, ["resume-candidate", "--json"])).available, false);
  const noSession = cli(cwd, env, ["task", "--resume", "continue"]);
  assert.equal(noSession.status, 1);
  assert.match(noSession.stdout, /No previous Claude session/);
  assert.equal(cli(cwd, env, ["task", "first"]).status, 0);
  const candidate = json(cli(cwd, env, ["resume-candidate", "--json"]));
  assert.equal(candidate.available, true);
  assert.equal(candidate.sessionId, "sess-9");
  assert.equal(cli(cwd, env, ["task", "--resume", "continue"]).status, 0);
  const resumed = readJobFile(cwd, listJobs(cwd, env)[0].id, env).request;
  assert.ok(resumed.claudeArgs.includes("--resume") && resumed.claudeArgs.includes("sess-9"));
});

test("task failures exit 1 with the classified message", () => {
  const result = cli(makeTempDir(), envFor({ FAKE_CLAUDE_MODE: "auth-error" }), ["task", "hi"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /claude auth login/);
  const garbage = cli(makeTempDir(), envFor({ FAKE_CLAUDE_MODE: "garbage" }), ["task", "--json", "hi"]);
  assert.equal(garbage.status, 1);
  assert.equal(json(garbage).error.kind, "parse");
});

test("review renders structured findings and rejects non-git dirs", () => {
  const env = envFor({ FAKE_CLAUDE_MODE: "structured" });
  const repo = makeTempDir();
  makeGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "let x = null;\n");
  const result = cli(repo, env, ["review", "--adversarial", "focus on auth"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Claude Review \(working tree\)/);
  assert.ok(result.stdout.indexOf("[HIGH]") < result.stdout.indexOf("[LOW]"));
  const request = readJobFile(repo, listJobs(repo, env)[0].id, env).request;
  assert.ok(request.claudeArgs.includes("--json-schema"));
  assert.ok(request.claudeArgs.includes("dontAsk"));
  assert.match(request.prompt, /adversarial/i);
  assert.match(request.prompt, /User focus: focus on auth/);
  assert.match(request.prompt, /let x = null/);
  const notGit = cli(makeTempDir(), env, ["review"]);
  assert.equal(notGit.status, 1);
  assert.match(notGit.stdout, /Not a git repository/);
});

test("background task, status, result, cancel", async () => {
  const env = envFor({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLEEP_MS: "700", FAKE_CLAUDE_RESULT: "bg done" });
  const cwd = makeTempDir();
  const launch = cli(cwd, env, ["task", "--background", "long job"]);
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = launch.stdout.match(/job (job-[0-9a-z-]+)/)[1];
  assert.equal(await waitFor(() => listJobs(cwd, env)[0].status === "succeeded"), true);
  assert.match(cli(cwd, env, ["status"]).stdout, new RegExp(jobId));
  const result = cli(cwd, env, ["result", jobId]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /bg done/);
  assert.equal(json(cli(cwd, env, ["result", "--json"])).result.result, "bg done");
  const cancelDone = cli(cwd, env, ["cancel", jobId]);
  assert.equal(cancelDone.status, 1);
  assert.match(cancelDone.stdout, /already succeeded/);
  assert.match(cli(cwd, env, ["result", "job-nope"]).stdout, /No job named job-nope/);
});

test("usage errors exit 1", () => {
  assert.equal(cli(makeTempDir(), envFor(), ["bogus"]).status, 1);
  const empty = cli(makeTempDir(), envFor(), ["task"]);
  assert.equal(empty.status, 1);
  assert.match(empty.stdout + empty.stderr, /prompt/i);
});
