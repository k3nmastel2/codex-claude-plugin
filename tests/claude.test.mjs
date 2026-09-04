import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import {
  buildClaudeArgs, parseResultEnvelope, classifyFailure, resolveClaudeCommand, resolveWindowsClaude, READ_ONLY_DISALLOWED
} from "../plugins/claude/scripts/lib/claude.mjs";

const has = (args, ...seq) => {
  const index = args.indexOf(seq[0]);
  return index !== -1 && seq.every((value, offset) => args[index + offset] === value);
};

test("read-only uses --restricted on a new enough CLI and a deny list on older ones", () => {
  const modern = buildClaudeArgs({ permission: "read", claudeVersion: "2.1.261 (Claude Code)" });
  assert.deepEqual(modern.slice(0, 3), ["-p", "--output-format", "json"]);
  assert.ok(has(modern, "--permission-mode", "dontAsk"));
  assert.ok(modern.includes("--restricted"));
  assert.ok(has(modern, "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit"));
  assert.equal(modern.includes("--dangerously-skip-permissions"), false);
  const legacy = buildClaudeArgs({ permission: "read", claudeVersion: "2.1.238 (Claude Code)" });
  assert.equal(legacy.includes("--restricted"), false);
  assert.ok(has(legacy, "--disallowedTools", READ_ONLY_DISALLOWED));
  assert.ok(READ_ONLY_DISALLOWED.split(",").includes("Bash"), "legacy read-only denies Bash by rule");
  assert.equal(buildClaudeArgs({ permission: "read" }).includes("--restricted"), false, "unknown version falls back to the deny list");
});

test("write and full permission levels", () => {
  assert.ok(has(buildClaudeArgs({ permission: "write" }), "--permission-mode", "acceptEdits"));
  const full = buildClaudeArgs({ permission: "full" });
  assert.ok(full.includes("--dangerously-skip-permissions"));
  assert.equal(full.includes("--permission-mode"), false);
});

test("optional flags are appended only when present", () => {
  const args = buildClaudeArgs({
    permission: "read", allow: ["Bash(npm test:*)", "WebFetch"], resumeSessionId: "s-1", model: "opus", effort: "high",
    maxTurns: 5, maxBudgetUsd: 1.5, addDirs: ["../lib"], name: "Codex → Claude: hi", appendSystemPrompt: "ctx", jsonSchema: "{}"
  });
  assert.ok(has(args, "--allowedTools", "Bash(npm test:*),WebFetch"));
  assert.ok(has(args, "--resume", "s-1"));
  assert.ok(has(args, "--model", "opus"));
  assert.ok(has(args, "--effort", "high"));
  assert.ok(has(args, "--max-turns", "5"));
  assert.ok(has(args, "--max-budget-usd", "1.5"));
  assert.ok(has(args, "--add-dir", "../lib"));
  assert.ok(has(args, "--name", "Codex → Claude: hi"));
  assert.ok(has(args, "--append-system-prompt", "ctx"));
  assert.ok(has(args, "--json-schema", "{}"));
  assert.equal(buildClaudeArgs({ permission: "read" }).includes("--model"), false);
});

test("invalid effort and permission throw", () => {
  assert.throws(() => buildClaudeArgs({ permission: "read", effort: "turbo" }), /Unsupported effort/);
  assert.throws(() => buildClaudeArgs({ permission: "yolo" }), /Unsupported permission level/);
});

test("promptViaArgv places the prompt last, after --", () => {
  const args = buildClaudeArgs({ permission: "read", promptViaArgv: "hello world" });
  assert.equal(args[args.length - 1], "hello world");
  assert.equal(args[args.length - 2], "--");
});

test("parseResultEnvelope takes the last result line and ignores noise", () => {
  const stdout = `noise\n{"type":"system"}\n{"type":"result","result":"ok","session_id":"s"}\n`;
  assert.equal(parseResultEnvelope(stdout).envelope.result, "ok");
  assert.equal(parseResultEnvelope("garbage").envelope, null);
  assert.match(parseResultEnvelope("").error, /no JSON result/i);
});

test("classifyFailure maps every failure kind", () => {
  assert.equal(classifyFailure({ envelope: { is_error: false }, status: 0 }), null);
  assert.equal(classifyFailure({ timedOut: true, timeoutMs: 1000 }).kind, "timeout");
  assert.equal(classifyFailure({ error: Object.assign(new Error("x"), { code: "ENOENT" }) }).kind, "missing");
  const auth = classifyFailure({ envelope: { is_error: true, result: "Failed to authenticate: OAuth session expired" }, status: 1 });
  assert.equal(auth.kind, "auth");
  assert.match(auth.message, /claude auth login/);
  assert.equal(classifyFailure({ envelope: { is_error: true, result: "rate limited" }, status: 1 }).kind, "api");
  assert.equal(classifyFailure({ envelope: null, status: 2, stderr: "boom" }).kind, "exit");
  assert.equal(classifyFailure({ envelope: null, status: 0, stdout: "not json" }).kind, "parse");
});

test("resolveClaudeCommand honours the env override", () => {
  const resolved = resolveClaudeCommand({ CLAUDE_COMPANION_CLAUDE_CMD: `"${process.execPath}" /x/fake.mjs` });
  assert.deepEqual(resolved, { command: process.execPath, args: ["/x/fake.mjs"], shell: false });
  assert.deepEqual(resolveClaudeCommand({}, { platform: "darwin" }), { command: "claude", args: [], shell: false });
});

test("resolveWindowsClaude prefers .exe, then unwraps npm .cmd shims, else null", () => {
  const exe = resolveWindowsClaude("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\Users\\me\\.local\\bin\\claude.exe\r\n", () => true);
  assert.deepEqual(exe, { command: "C:\\Users\\me\\.local\\bin\\claude.exe", args: [], shell: false });
  const cli = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
  const cmd = resolveWindowsClaude("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\r\n", (p) => p === cli);
  assert.deepEqual(cmd, { command: process.execPath, args: [cli], shell: false });
  assert.equal(resolveWindowsClaude("", () => false), null);
});

test("resolveWindowsClaude reads the npm shim to find the real script", () => {
  const shimPath = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd";
  const target = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.js";
  const shim = '@ECHO off\r\n...\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.js" %*\r\n';
  const resolved = resolveWindowsClaude(`${shimPath}\r\n`, (p) => p === target, () => shim);
  assert.deepEqual(resolved, { command: process.execPath, args: [target], shell: false });
  const unreadable = resolveWindowsClaude(`${shimPath}\r\n`, () => false, () => { throw new Error("nope"); });
  assert.equal(unreadable, null, "an unsupported shim is never routed through a shell");
});

test("read-only with --allow ignores settings files and allows exactly the given rule", () => {
  const args = buildClaudeArgs({ permission: "read", claudeVersion: "2.1.261 (Claude Code)", allow: ["Bash(npm test:*)"] });
  assert.equal(args.includes("--restricted"), false, "restricted cannot re-add a single tool");
  assert.ok(has(args, "--setting-sources", ""), "user/project/local allow rules must not apply");
  const deny = args[args.indexOf("--disallowedTools") + 1];
  assert.equal(deny.split(",").includes("Bash"), false, "deny would beat the allow rule");
  assert.ok(deny.split(",").includes("Edit"));
  assert.ok(has(args, "--allowedTools", "Bash(npm test:*)"));
});

test("version helpers and the argv prompt separator", async () => {
  const { parseClaudeVersion, supportsRestricted } = await import("../plugins/claude/scripts/lib/claude.mjs");
  assert.deepEqual(parseClaudeVersion("2.1.261 (Claude Code)"), [2, 1, 261]);
  assert.equal(parseClaudeVersion("not found"), null);
  assert.equal(supportsRestricted("2.1.248 (Claude Code)"), true);
  assert.equal(supportsRestricted("2.1.247 (Claude Code)"), false);
  assert.equal(supportsRestricted("3.0.0"), true);
  const args = buildClaudeArgs({ permission: "read", allow: ["Bash(x:*)"], promptViaArgv: "--looks-like-a-flag" });
  assert.deepEqual(args.slice(-2), ["--", "--looks-like-a-flag"]);
});
