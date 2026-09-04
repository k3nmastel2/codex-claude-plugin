import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../plugins/claude/scripts/lib/process.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRY = path.join(ROOT, "plugins", "claude", "scripts", "claude-companion.mjs");
export const FAKE_CLAUDE_PATH = path.join(ROOT, "tests", "fixtures", "fake-claude.mjs");
export const FAKE_CLAUDE_CMD = `"${process.execPath}" "${FAKE_CLAUDE_PATH}"`;

export function makeTempDir(prefix = "ccp-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeGitRepo(dir) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  for (const args of [["init", "-q", "-b", "main"], ["config", "commit.gpgsign", "false"]]) {
    const r = runCommand("git", args, { cwd: dir, env });
    if (r.status !== 0) throw new Error(r.stderr);
  }
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  for (const args of [["add", "."], ["commit", "-q", "-m", "init"]]) {
    const r = runCommand("git", args, { cwd: dir, env });
    if (r.status !== 0) throw new Error(r.stderr);
  }
}

// The suite may itself run inside Claude Code or Codex; drop every inherited Claude/Codex
// variable so nesting and fixture behaviour are controlled only by the test.
export function cleanEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(CLAUDECODE|CLAUDE_|CODEX_COMPANION_|FAKE_CLAUDE_)/.test(name)) continue;
    env[name] = value;
  }
  return env;
}

export function withStateDir(base = {}) {
  return { ...cleanEnv(), ...base, CLAUDE_COMPANION_STATE_DIR: makeTempDir("ccp-state-") };
}

export function realpath(p) {
  return fs.realpathSync.native(p);
}
