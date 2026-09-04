import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./process.mjs";

const DEFAULT_MAX_INLINE_BYTES = 256 * 1024;
const DEFAULT_MAX_UNTRACKED_BYTES = 24 * 1024;
export const REVIEW_SCOPES = ["auto", "working-tree", "branch"];

function git(cwd, args) {
  return runCommand("git", args, { cwd });
}

function gitOut(cwd, args) {
  const result = git(cwd, args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout;
}

function refExists(cwd, ref) {
  return git(cwd, ["rev-parse", "--verify", "--quiet", ref]).status === 0;
}

function splitNul(output) {
  return String(output ?? "").split("\0").filter(Boolean);
}

function isProbablyText(buffer) {
  return !buffer.subarray(0, 8000).includes(0);
}

export function isGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return !result.error && result.status === 0 && result.stdout.trim() === "true";
}

export function hasHead(cwd) {
  return refExists(cwd, "HEAD");
}

export function isDirty(cwd) {
  return gitOut(cwd, ["status", "--porcelain", "--untracked-files=all"]).trim().length > 0;
}

export function detectBaseRef(cwd) {
  const originHead = git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead.status === 0 && originHead.stdout.trim()) return originHead.stdout.trim();
  for (const candidate of ["main", "master"]) {
    if (refExists(cwd, candidate)) return candidate;
  }
  return null;
}

export function resolveReviewTarget(cwd, options = {}) {
  const scope = options.scope ?? "auto";
  // Validate options before touching the repository so a typo is reported even outside git.
  if (!REVIEW_SCOPES.includes(scope)) {
    throw new Error(`Unsupported --scope "${scope}". Use one of: ${REVIEW_SCOPES.join(", ")}.`);
  }
  if (!isGitRepository(cwd)) {
    throw new Error(`Not a git repository: ${cwd}`);
  }
  const explicitBase = options.base ?? null;
  const wantsBranch = scope === "branch" || (scope === "auto" && (explicitBase || !isDirty(cwd)));
  if (scope === "working-tree" || !wantsBranch) {
    return { mode: "working-tree", baseRef: null, label: "working tree" };
  }
  if (!hasHead(cwd)) {
    throw new Error("This repository has no commits yet, so there is no branch to review; commit first or review the working tree.");
  }
  const baseRef = explicitBase ?? detectBaseRef(cwd);
  if (!baseRef) {
    throw new Error("No base branch found; pass --base <ref>.");
  }
  if (!refExists(cwd, baseRef)) {
    throw new Error(`Base ref "${baseRef}" does not exist.`);
  }
  return { mode: "branch", baseRef, label: `branch vs ${baseRef}` };
}

// `git status --porcelain -z` emits "XY path" entries; renames add a second NUL-terminated entry
// holding the original path, which is skipped.
function listStatusFiles(porcelainZ) {
  const entries = splitNul(porcelainZ);
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return [...new Set(files)].sort();
}

// Untracked files are inlined only when they are regular text files that live inside the
// workspace; symlinks are skipped so a review can never pull in ~/.ssh or similar.
function collectUntracked(cwd, maxUntrackedBytes) {
  const root = fs.realpathSync.native(cwd);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const blocks = [];
  for (const relative of splitNul(gitOut(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]))) {
    const absolute = path.join(cwd, relative);
    let buffer;
    let fd;
    try {
      if (fs.lstatSync(absolute).isSymbolicLink()) continue;
      // Open without following symlinks and fstat the open descriptor, so the path cannot be
      // swapped for a link between the check and the read.
      fd = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > maxUntrackedBytes) continue;
      const real = fs.realpathSync.native(absolute);
      if (real !== root && !real.startsWith(root + path.sep)) continue;
      buffer = fs.readFileSync(fd);
    } catch {
      continue;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (!isProbablyText(buffer)) continue;
    blocks.push(`=== untracked: ${relative} ===\n${buffer.toString("utf8")}`);
  }
  return blocks.join("\n");
}

export function collectReviewContext(cwd, target, options = {}) {
  const maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const maxUntrackedBytes = options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES;
  let header;
  let diff;
  let extra = "";
  let files;
  let statArgs;

  if (target.mode === "working-tree") {
    const status = gitOut(cwd, ["status", "--short", "--untracked-files=all"]);
    header = `Working tree status:\n${status.trim() || "(clean)"}`;
    // A repository without a first commit has no HEAD; compare the index against the empty tree instead.
    const diffBase = hasHead(cwd) ? ["HEAD"] : ["--cached"];
    diff = gitOut(cwd, ["diff", ...diffBase]);
    extra = collectUntracked(cwd, maxUntrackedBytes);
    files = listStatusFiles(gitOut(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]));
    statArgs = ["diff", "--stat", ...diffBase];
  } else {
    const mergeBase = gitOut(cwd, ["merge-base", "HEAD", target.baseRef]).trim();
    const log = gitOut(cwd, ["log", "--oneline", `${mergeBase}..HEAD`]);
    header = `Commits since ${target.baseRef}:\n${log.trim() || "(none)"}`;
    diff = gitOut(cwd, ["diff", `${target.baseRef}...HEAD`]);
    files = splitNul(gitOut(cwd, ["diff", "-z", "--name-only", `${target.baseRef}...HEAD`])).sort();
    statArgs = ["diff", "--stat", `${target.baseRef}...HEAD`];
  }

  const inline = [diff.trim() ? `Diff:\n${diff}` : "", extra].filter(Boolean).join("\n\n");
  if (Buffer.byteLength(inline, "utf8") <= maxInlineBytes) {
    return { text: [header, inline].filter(Boolean).join("\n\n"), files, truncated: false };
  }
  const stat = gitOut(cwd, statArgs);
  const text = [
    header,
    "The full diff is too large to inline. Use your file-reading tools to inspect the changed files listed below.",
    `Diff stat:\n${stat}`,
    `Changed files:\n${files.map((file) => `- ${file}`).join("\n")}`
  ].join("\n\n");
  return { text, files, truncated: true };
}
