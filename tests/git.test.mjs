import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveReviewTarget, collectReviewContext, detectBaseRef, isDirty } from "../plugins/claude/scripts/lib/git.mjs";
import { runCommand } from "../plugins/claude/scripts/lib/process.mjs";
import { makeTempDir, makeGitRepo } from "./helpers.mjs";

const git = (cwd, ...args) => {
  const r = runCommand("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};

test("non-git directories are rejected, but a bad scope is reported first", () => {
  assert.throws(() => resolveReviewTarget(makeTempDir()), /Not a git repository/);
  assert.throws(() => resolveReviewTarget(makeTempDir(), { scope: "bogus" }), /Unsupported --scope/);
});

test("dirty tree resolves to working-tree and includes diff plus untracked text", () => {
  const repo = makeTempDir();
  makeGitRepo(repo);
  fs.appendFileSync(path.join(repo, "README.md"), "changed\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "brand new\n");
  fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]));
  assert.equal(isDirty(repo), true);
  const target = resolveReviewTarget(repo);
  assert.equal(target.mode, "working-tree");
  assert.equal(target.label, "working tree");
  const context = collectReviewContext(repo, target);
  assert.equal(context.truncated, false);
  assert.match(context.text, /\+changed/);
  assert.match(context.text, /=== untracked: new\.txt ===\nbrand new/);
  assert.equal(context.text.includes("blob.bin ==="), false);
  assert.ok(context.files.includes("README.md"));
  assert.ok(context.files.includes("new.txt"));
});

test("clean feature branch resolves to branch mode against main", () => {
  const repo = makeTempDir();
  makeGitRepo(repo);
  git(repo, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(repo, "feature.js"), "export const x = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "add feature");
  assert.equal(detectBaseRef(repo), "main");
  const target = resolveReviewTarget(repo);
  assert.deepEqual(target, { mode: "branch", baseRef: "main", label: "branch vs main" });
  const context = collectReviewContext(repo, target);
  assert.match(context.text, /add feature/);
  assert.match(context.text, /\+export const x = 1;/);
  assert.deepEqual(context.files, ["feature.js"]);
});

test("explicit --base forces branch mode and a missing base throws", () => {
  const repo = makeTempDir();
  makeGitRepo(repo);
  git(repo, "checkout", "-q", "-b", "topic");
  assert.equal(resolveReviewTarget(repo, { base: "main" }).mode, "branch");
  git(repo, "branch", "-m", "main", "trunk");
  assert.throws(() => resolveReviewTarget(repo, { scope: "branch" }), /No base branch found/);
});

test("oversize diffs fall back to a stat summary", () => {
  const repo = makeTempDir();
  makeGitRepo(repo);
  fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(5000) + "\n");
  const context = collectReviewContext(repo, resolveReviewTarget(repo), { maxInlineBytes: 1000 });
  assert.equal(context.truncated, true);
  assert.match(context.text, /too large to inline/i);
  assert.match(context.text, /big\.txt/);
});

test("a repository with no commits can still be reviewed as a working tree", () => {
  const repo = makeTempDir();
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "first.js"), "export const a = 1;\n");
  git(repo, "add", "first.js");
  fs.writeFileSync(path.join(repo, "second.js"), "export const b = 2;\n");
  const target = resolveReviewTarget(repo);
  assert.equal(target.mode, "working-tree");
  const context = collectReviewContext(repo, target);
  assert.match(context.text, /\+export const a = 1;/);
  assert.match(context.text, /=== untracked: second\.js ===/);
  assert.throws(() => resolveReviewTarget(repo, { scope: "branch" }), /no commits yet/);
});

test("untracked symlinks are never inlined and invalid scopes are rejected", { skip: process.platform === "win32" }, () => {
  const repo = makeTempDir();
  makeGitRepo(repo);
  const secret = path.join(makeTempDir(), "secret.txt");
  fs.writeFileSync(secret, "TOP-SECRET-CONTENT\n");
  fs.symlinkSync(secret, path.join(repo, "link.txt"));
  fs.writeFileSync(path.join(repo, "plain.txt"), "plain\n");
  const context = collectReviewContext(repo, resolveReviewTarget(repo));
  assert.equal(context.text.includes("TOP-SECRET-CONTENT"), false);
  assert.match(context.text, /=== untracked: plain\.txt ===/);
  assert.throws(() => resolveReviewTarget(repo, { scope: "everything" }), /Unsupported --scope/);
});
