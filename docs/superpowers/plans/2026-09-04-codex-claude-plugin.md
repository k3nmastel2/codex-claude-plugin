# Codex → Claude Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Codex plugin whose skills drive Claude Code's local CLI (`claude -p`) through a dependency-free Node companion script, published as a GitHub repo that is also a Codex marketplace.

**Architecture:** `plugins/claude/scripts/claude-companion.mjs` is a small CLI (`setup`, `task`, `review`, `status`, `result`, `cancel`, `resume-candidate`, `__worker`) built from focused modules under `scripts/lib/`. Four thin Codex skills forward user requests to that CLI and return its stdout verbatim. Per-workspace state (last Claude session id, job records, logs) lives under `$CODEX_HOME/claude-companion/state/`. Tests use Node's built-in runner and a fake `claude` binary; nothing in the test suite needs credentials.

**Tech Stack:** Node.js ≥ 20 (ESM, `node:test`, `node:child_process`), git, Codex CLI ≥ 0.145 plugin/marketplace format, Claude Code CLI ≥ 2.1 headless mode.

**Spec:** `docs/superpowers/specs/2026-09-04-codex-claude-plugin-design.md`

## Global Constraints

- Node.js 20 or newer; no npm dependencies at runtime or in tests (`package.json` has no `dependencies` or `devDependencies`).
- Every script is ESM (`.mjs`), uses only `node:` built-ins, and must run unchanged on macOS, Linux, and Windows. No bash, no shell pipelines in code.
- Plugin manifest name is `claude`; marketplace name is `codex-claude-plugin`; skills are `claude-task`, `claude-review`, `claude-setup`, `claude-jobs`.
- Default permission level is read-only. `--write` and `--full` must be explicit. Review never escalates.
- The companion never fabricates an answer when Claude did not run. Failures exit 1 with one actionable line plus up to 20 stderr lines.
- The prompt is delivered to Claude on stdin, never in argv, unless `CLAUDE_COMPANION_PROMPT_VIA_ARGV=1`.
- State root: `$CLAUDE_COMPANION_STATE_DIR`, else `$CODEX_HOME/claude-companion/state`, else `~/.codex/claude-companion/state`. Keep at most 50 jobs per workspace.
- Loop guard: refuse when `CLAUDE_COMPANION_DEPTH >= CLAUDE_COMPANION_MAX_DEPTH` (default 1) or when `CLAUDECODE=1` is inherited, unless `--allow-nested`.
- Timestamps are ISO 8601 UTC strings from `new Date().toISOString()`.
- Commit after every task with a conventional-commit message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `npm test` before every commit; it must be green.

---

## File Map

| Path | Responsibility |
|---|---|
| `package.json` | Private package; `npm test` → `node --test tests/`. |
| `.gitignore`, `LICENSE`, `CHANGELOG.md`, `README.md` | Repo hygiene and user docs. |
| `.agents/plugins/marketplace.json` | Marketplace `codex-claude-plugin` listing plugin `claude`. |
| `plugins/claude/.codex-plugin/plugin.json` | Codex plugin manifest. |
| `plugins/claude/assets/claude-plugin.svg` | Icon referenced by the manifest. |
| `plugins/claude/schemas/review-output.schema.json` | Structured review output schema. |
| `plugins/claude/prompts/codex-context.md` | Appended system prompt for every Claude run. |
| `plugins/claude/prompts/review.md`, `adversarial-review.md` | Review prompt templates. |
| `plugins/claude/scripts/lib/args.mjs` | argv parsing, raw-string splitting. |
| `plugins/claude/scripts/lib/process.mjs` | `runCommand`, `binaryAvailable`, `terminateProcessTree`. |
| `plugins/claude/scripts/lib/env.mjs` | Nesting detection, child env scrubbing. |
| `plugins/claude/scripts/lib/workspace.mjs` | Workspace root resolution (git top-level or cwd). |
| `plugins/claude/scripts/lib/state.mjs` | State dir, `state.json`, job files, last session. |
| `plugins/claude/scripts/lib/claude.mjs` | Locate `claude`, build argv, run it, parse envelope, classify failures. |
| `plugins/claude/scripts/lib/git.mjs` | Review target resolution and context collection. |
| `plugins/claude/scripts/lib/prompts.mjs` | Template loading and interpolation, review prompt builder. |
| `plugins/claude/scripts/lib/jobs.mjs` | Job lifecycle: create, execute, background worker, cancel, status snapshot. |
| `plugins/claude/scripts/lib/render.mjs` | Text rendering for every command. |
| `plugins/claude/scripts/claude-companion.mjs` | CLI entry point and command dispatch. |
| `plugins/claude/skills/<name>/SKILL.md` + `agents/openai.yaml` | Four Codex skills. |
| `tests/fixtures/fake-claude.mjs` | Stand-in `claude` binary driven by `FAKE_CLAUDE_MODE`. |
| `tests/helpers.mjs` | Temp dirs, env builders, fixture command string. |
| `tests/*.test.mjs` | One test file per module plus `cli.test.mjs`. |
| `.github/workflows/test.yml` | ubuntu/macos/windows × Node 20/22. |

---

### Task 1: Repository scaffolding, manifest, marketplace, schema

**Files:**
- Create: `package.json`, `.gitignore`, `LICENSE`, `CHANGELOG.md`
- Create: `.agents/plugins/marketplace.json`
- Create: `plugins/claude/.codex-plugin/plugin.json`
- Create: `plugins/claude/assets/claude-plugin.svg`
- Create: `plugins/claude/schemas/review-output.schema.json`
- Create: `tests/manifest.test.mjs`

**Interfaces:**
- Produces: the plugin root `plugins/claude/` that every later task writes into; `schemas/review-output.schema.json` consumed by Task 6 and Task 9.

- [ ] **Step 1: Write the failing test**

`tests/manifest.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

test("plugin manifest has the required fields", () => {
  const manifest = readJson("plugins/claude/.codex-plugin/plugin.json");
  assert.equal(manifest.name, "claude");
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.interface.displayName, "Claude");
  assert.ok(fs.existsSync(path.join(ROOT, "plugins/claude", manifest.interface.composerIcon)));
  assert.equal("hooks" in manifest, false);
});

test("marketplace lists the plugin from ./plugins/claude", () => {
  const marketplace = readJson(".agents/plugins/marketplace.json");
  assert.equal(marketplace.name, "codex-claude-plugin");
  const entry = marketplace.plugins.find((p) => p.name === "claude");
  assert.deepEqual(entry.source, { source: "local", path: "./plugins/claude" });
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
  assert.ok(entry.category);
});

test("review schema requires verdict, summary, findings, next_steps", () => {
  const schema = readJson("plugins/claude/schemas/review-output.schema.json");
  assert.deepEqual(schema.required, ["verdict", "summary", "findings", "next_steps"]);
  assert.deepEqual(schema.properties.verdict.enum, ["approve", "needs-attention"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` (from repo root)
Expected: FAIL — `package.json` missing, then ENOENT on the manifest.

- [ ] **Step 3: Create package.json, .gitignore, LICENSE, CHANGELOG.md**

`package.json`:

```json
{
  "name": "codex-claude-plugin",
  "version": "0.1.0",
  "private": true,
  "description": "Codex plugin that delegates work to Claude Code through its local CLI.",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test tests/"
  },
  "license": "MIT"
}
```

`.gitignore`:

```
node_modules/
.DS_Store
*.log
```

`LICENSE`: the MIT license text with `Copyright (c) 2026 Ken Nguyen`.

`CHANGELOG.md`:

```markdown
# Changelog

## 0.1.0 — unreleased

- Initial release: `claude-task`, `claude-review`, `claude-setup`, `claude-jobs` skills backed by `claude-companion.mjs`.
```

- [ ] **Step 4: Create the plugin manifest**

`plugins/claude/.codex-plugin/plugin.json`:

```json
{
  "name": "claude",
  "version": "0.1.0",
  "description": "Delegate tasks, investigations, and code reviews to Claude Code through its local CLI. No API key required.",
  "author": {
    "name": "Ken Nguyen",
    "url": "https://github.com/k3nmastel2"
  },
  "homepage": "https://github.com/k3nmastel2/codex-claude-plugin",
  "repository": "https://github.com/k3nmastel2/codex-claude-plugin",
  "license": "MIT",
  "keywords": ["claude", "claude-code", "delegation", "code-review", "second-opinion"],
  "skills": "./skills/",
  "interface": {
    "displayName": "Claude",
    "shortDescription": "Hand work to Claude Code from Codex",
    "longDescription": "Use Claude Code from inside Codex the same way the Codex plugin works inside Claude Code: delegate a task or investigation, request a structured code review of your working tree or branch, run long jobs in the background, and resume the last Claude thread. Talks to the claude CLI you already have installed and logged in; nothing is sent to an API from this plugin.",
    "developerName": "Ken Nguyen",
    "category": "Developer Tools",
    "capabilities": ["Read", "Write"],
    "websiteURL": "https://github.com/k3nmastel2/codex-claude-plugin",
    "defaultPrompt": [
      "Use $claude-task to get a second opinion on this bug",
      "Use $claude-review to review my working tree",
      "Use $claude-setup to check Claude Code is ready"
    ],
    "brandColor": "#6B4FBB",
    "composerIcon": "./assets/claude-plugin.svg",
    "logo": "./assets/claude-plugin.svg",
    "screenshots": []
  }
}
```

- [ ] **Step 5: Create the icon, marketplace, and schema**

`plugins/claude/assets/claude-plugin.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="14" fill="#6B4FBB"/>
  <path d="M18 40 L32 16 L46 40 M24 32 L40 32" stroke="#FFFFFF" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="50" cy="50" r="6" fill="#FFFFFF"/>
</svg>
```

`.agents/plugins/marketplace.json`:

```json
{
  "name": "codex-claude-plugin",
  "interface": {
    "displayName": "Codex ↔ Claude"
  },
  "plugins": [
    {
      "name": "claude",
      "source": {
        "source": "local",
        "path": "./plugins/claude"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
```

`plugins/claude/schemas/review-output.schema.json`: copy verbatim from
`~/.claude/plugins/cache/openai-codex/codex/1.0.4/schemas/review-output.schema.json`
(draft 2020-12; `verdict` enum `approve`/`needs-attention`; `findings[]` items require
`severity` (`critical|high|medium|low`), `title`, `body`, `file`, `line_start`, `line_end`
(integers ≥ 1), `confidence` (0–1), `recommendation`; `next_steps` string array;
`additionalProperties: false` everywhere).

- [ ] **Step 6: Run tests and the Codex validator**

Run: `npm test`
Expected: 3 passing.

Run: `python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/claude`
Expected: `Plugin validation passed: …/plugins/claude`. If it reports a missing required interface field, add that field with a real value and re-run.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold plugin manifest, marketplace, schema, and test runner

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Argument parsing (`lib/args.mjs`)

**Files:**
- Create: `plugins/claude/scripts/lib/args.mjs`
- Test: `tests/args.test.mjs`

**Interfaces:**
- Produces: `parseArgs(argv, { valueOptions?, booleanOptions?, repeatableOptions?, aliasMap? }) → { options: Record<string, string|boolean|string[]>, positionals: string[] }`; `splitRawArgumentString(raw: string) → string[]`; `normalizeArgv(argv: string[]) → string[]` (a single argument is split with `splitRawArgumentString`).

- [ ] **Step 1: Write the failing tests**

`tests/args.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, splitRawArgumentString, normalizeArgv } from "../plugins/claude/scripts/lib/args.mjs";

const CONFIG = {
  valueOptions: ["model", "effort", "cwd"],
  booleanOptions: ["write", "full", "background", "json"],
  repeatableOptions: ["allow", "add-dir"],
  aliasMap: { C: "cwd" }
};

test("parses booleans, values, positionals", () => {
  const { options, positionals } = parseArgs(["--write", "--model", "opus", "explain", "this"], CONFIG);
  assert.equal(options.write, true);
  assert.equal(options.model, "opus");
  assert.deepEqual(positionals, ["explain", "this"]);
});

test("supports --key=value and short aliases", () => {
  const { options } = parseArgs(["--effort=high", "-C", "/tmp/x"], CONFIG);
  assert.equal(options.effort, "high");
  assert.equal(options.cwd, "/tmp/x");
});

test("collects repeatable options into arrays", () => {
  const { options } = parseArgs(["--allow", "Bash(npm test:*)", "--allow", "Read", "--add-dir", "../lib"], CONFIG);
  assert.deepEqual(options.allow, ["Bash(npm test:*)", "Read"]);
  assert.deepEqual(options["add-dir"], ["../lib"]);
});

test("stops option parsing at --", () => {
  const { options, positionals } = parseArgs(["--json", "--", "--not-a-flag", "text"], CONFIG);
  assert.equal(options.json, true);
  assert.deepEqual(positionals, ["--not-a-flag", "text"]);
});

test("unknown flags become positionals so prompts survive", () => {
  const { positionals } = parseArgs(["--verbose", "hi"], CONFIG);
  assert.deepEqual(positionals, ["--verbose", "hi"]);
});

test("throws on a value option with no value", () => {
  assert.throws(() => parseArgs(["--model"], CONFIG), /Missing value for --model/);
});

test("splitRawArgumentString honours quotes and escapes", () => {
  assert.deepEqual(splitRawArgumentString(`--write "fix the \\"auth\\" bug" 'single quoted'`), [
    "--write", 'fix the "auth" bug', "single quoted"
  ]);
});

test("splitRawArgumentString keeps Windows path backslashes", () => {
  assert.deepEqual(splitRawArgumentString('"C:\\Program Files\\nodejs\\node.exe" C:\\x\\fake.mjs'), [
    "C:\\Program Files\\nodejs\\node.exe", "C:\\x\\fake.mjs"
  ]);
});

test("normalizeArgv splits a single raw string, leaves arrays alone", () => {
  assert.deepEqual(normalizeArgv(["--write fix it"]), ["--write", "fix", "it"]);
  assert.deepEqual(normalizeArgv(["--write", "fix it"]), ["--write", "fix it"]);
  assert.deepEqual(normalizeArgv(["   "]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/args.test.mjs`
Expected: FAIL — cannot find module `args.mjs`.

- [ ] **Step 3: Implement `lib/args.mjs`**

```js
export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const repeatableOptions = new Set(config.repeatableOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  const setValue = (key, value) => {
    if (repeatableOptions.has(key)) {
      options[key] = [...(options[key] ?? []), value];
    } else {
      options[key] = value;
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }

    const isLong = token.startsWith("--");
    const body = token.slice(isLong ? 2 : 1);
    const [rawKey, inlineValue] = isLong ? body.split(/=(.*)/s, 2) : [body, undefined];
    const key = aliasMap[rawKey] ?? rawKey;

    if (booleanOptions.has(key)) {
      options[key] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }
    if (valueOptions.has(key) || repeatableOptions.has(key)) {
      const nextValue = inlineValue ?? argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for ${isLong ? "--" : "-"}${rawKey}`);
      }
      setValue(key, nextValue);
      if (inlineValue === undefined) index += 1;
      continue;
    }
    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let hasToken = false;
  const chars = [...String(raw ?? "")];

  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index];
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    // A backslash escapes only quotes, backslashes, and whitespace, so Windows
    // paths such as C:\Program Files\node.exe pass through untouched.
    if (character === "\\" && quote !== "'" && /["'\\\s]/.test(chars[index + 1] ?? "")) {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      hasToken = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (current || hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += character;
    hasToken = true;
  }
  if (escaping) current += "\\";
  if (current || hasToken) tokens.push(current);
  return tokens;
}

export function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) return [];
    return splitRawArgumentString(raw);
  }
  return argv;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/args.test.mjs`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/lib/args.mjs tests/args.test.mjs
git commit -m "feat(companion): argument parser with raw-string splitting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Process helpers (`lib/process.mjs`)

**Files:**
- Create: `plugins/claude/scripts/lib/process.mjs`
- Test: `tests/process.test.mjs`

**Interfaces:**
- Consumes: `splitRawArgumentString` from Task 2.
- Produces: `runCommand(command, args, { cwd?, env?, input?, maxBuffer?, timeoutMs?, shell? }) → { command, args, status: number|null, signal: string|null, stdout: string, stderr: string, error: Error|null }`; `binaryAvailable(command, versionArgs = ["--version"], { cwd?, env? }) → { available: boolean, detail: string }`; `terminateProcessTree(pid: number) → { attempted: boolean, delivered: boolean, method: string|null }`; `resolveCommandSpec(spec: string) → { command: string, args: string[] }`.

- [ ] **Step 1: Write the failing tests**

`tests/process.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import { runCommand, binaryAvailable, terminateProcessTree, resolveCommandSpec } from "../plugins/claude/scripts/lib/process.mjs";

test("runCommand captures stdout and status", () => {
  const result = runCommand(process.execPath, ["-e", "console.log('hi')"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "hi");
  assert.equal(result.error, null);
});

test("runCommand forwards input on stdin", () => {
  const result = runCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "abc" });
  assert.equal(result.stdout, "abc");
});

test("binaryAvailable reports a missing binary without throwing", () => {
  const status = binaryAvailable("definitely-not-a-real-binary-xyz");
  assert.equal(status.available, false);
  assert.match(status.detail, /not found/);
});

test("binaryAvailable reports node itself", () => {
  const status = binaryAvailable(process.execPath);
  assert.equal(status.available, true);
  assert.match(status.detail, /^v\d+/);
});

test("resolveCommandSpec splits a command string with quoting", () => {
  assert.deepEqual(resolveCommandSpec("node /x/fake.mjs"), { command: "node", args: ["/x/fake.mjs"] });
  assert.deepEqual(resolveCommandSpec('"C:\\Program Files\\node.exe" a b'), { command: "C:\\Program Files\\node.exe", args: ["a", "b"] });
});

test("terminateProcessTree kills a detached child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32", stdio: "ignore", windowsHide: true
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const report = terminateProcessTree(child.pid);
  assert.equal(report.attempted, true);
  const exited = await Promise.race([
    new Promise((resolve) => child.on("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000))
  ]);
  assert.equal(exited, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/process.test.mjs`
Expected: FAIL — cannot find module `process.mjs`.

- [ ] **Step 3: Implement `lib/process.mjs`**

```js
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
    } catch (error) {
      return { attempted: true, delivered: error?.code !== "ESRCH" ? false : false, method: "kill" };
    }
  }
  try {
    process.kill(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (groupError) {
    if (groupError?.code !== "ESRCH" && groupError?.code !== "EPERM") {
      // fall through to single-process kill
    }
    try {
      process.kill(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (error) {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/process.test.mjs`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/lib/process.mjs tests/process.test.mjs
git commit -m "feat(companion): cross-platform process helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Nesting guard and child environment (`lib/env.mjs`)

**Files:**
- Create: `plugins/claude/scripts/lib/env.mjs`
- Test: `tests/env.test.mjs`

**Interfaces:**
- Produces: `DEPTH_ENV = "CLAUDE_COMPANION_DEPTH"`, `MAX_DEPTH_ENV = "CLAUDE_COMPANION_MAX_DEPTH"`, `PARENT_ENV = "CLAUDE_COMPANION_PARENT"`; `readDepth(env) → number`; `readMaxDepth(env) → number`; `detectNesting(env, { allowNested?: boolean }) → { nested: boolean, depth: number, maxDepth: number, reason: string|null }`; `shouldScrub(name: string) → boolean`; `buildChildEnv(env) → Record<string,string>`.

- [ ] **Step 1: Write the failing tests**

`tests/env.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectNesting, buildChildEnv, shouldScrub, readDepth, DEPTH_ENV, PARENT_ENV } from "../plugins/claude/scripts/lib/env.mjs";

test("fresh environment is not nested", () => {
  const report = detectNesting({ PATH: "/usr/bin" });
  assert.deepEqual(report, { nested: false, depth: 0, maxDepth: 1, reason: null });
});

test("depth at or above max is nested", () => {
  const report = detectNesting({ CLAUDE_COMPANION_DEPTH: "1" });
  assert.equal(report.nested, true);
  assert.match(report.reason, /depth 1/);
});

test("inherited CLAUDECODE=1 is nested", () => {
  const report = detectNesting({ CLAUDECODE: "1" });
  assert.equal(report.nested, true);
  assert.match(report.reason, /Claude Code session/);
});

test("max depth can be raised and allowNested overrides", () => {
  assert.equal(detectNesting({ CLAUDE_COMPANION_DEPTH: "1", CLAUDE_COMPANION_MAX_DEPTH: "2" }).nested, false);
  assert.equal(detectNesting({ CLAUDECODE: "1" }, { allowNested: true }).nested, false);
});

test("readDepth tolerates garbage", () => {
  assert.equal(readDepth({ CLAUDE_COMPANION_DEPTH: "banana" }), 0);
  assert.equal(readDepth({ CLAUDE_COMPANION_DEPTH: "3" }), 3);
});

test("shouldScrub matches Claude session variables but not ANTHROPIC_*", () => {
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_PLUGIN_DATA", "CODEX_COMPANION_SESSION_ID"]) {
    assert.equal(shouldScrub(name), true, name);
  }
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "PATH", "CODEX_HOME"]) {
    assert.equal(shouldScrub(name), false, name);
  }
});

test("buildChildEnv scrubs, increments depth, and tags the parent", () => {
  const child = buildChildEnv({ PATH: "/usr/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "x", ANTHROPIC_API_KEY: "k", CLAUDE_COMPANION_DEPTH: "0" });
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.ANTHROPIC_API_KEY, "k");
  assert.equal("CLAUDECODE" in child, false);
  assert.equal("CLAUDE_CODE_ENTRYPOINT" in child, false);
  assert.equal(child[DEPTH_ENV], "1");
  assert.equal(child[PARENT_ENV], "codex");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/env.test.mjs`
Expected: FAIL — cannot find module `env.mjs`.

- [ ] **Step 3: Implement `lib/env.mjs`**

```js
export const DEPTH_ENV = "CLAUDE_COMPANION_DEPTH";
export const MAX_DEPTH_ENV = "CLAUDE_COMPANION_MAX_DEPTH";
export const PARENT_ENV = "CLAUDE_COMPANION_PARENT";

const SCRUB_EXACT = new Set(["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_AGENT_SDK_VERSION"]);
const SCRUB_PREFIXES = ["CLAUDE_CODE_", "CLAUDE_PLUGIN_", "CODEX_COMPANION_"];

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readDepth(env) {
  return parseNonNegativeInt(env[DEPTH_ENV], 0);
}

export function readMaxDepth(env) {
  return Math.max(1, parseNonNegativeInt(env[MAX_DEPTH_ENV], 1));
}

export function detectNesting(env, options = {}) {
  const depth = readDepth(env);
  const maxDepth = readMaxDepth(env);
  if (options.allowNested) {
    return { nested: false, depth, maxDepth, reason: null };
  }
  if (depth >= maxDepth) {
    return {
      nested: true,
      depth,
      maxDepth,
      reason: `Nesting depth ${depth} reached the limit of ${maxDepth} (${DEPTH_ENV}/${MAX_DEPTH_ENV}).`
    };
  }
  if (String(env.CLAUDECODE ?? "") === "1") {
    return {
      nested: true,
      depth,
      maxDepth,
      reason: "This Codex process was started inside a Claude Code session (CLAUDECODE=1); refusing to spawn another Claude."
    };
  }
  return { nested: false, depth, maxDepth, reason: null };
}

export function shouldScrub(name) {
  if (SCRUB_EXACT.has(name)) return true;
  return SCRUB_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function buildChildEnv(env) {
  const child = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || shouldScrub(name)) continue;
    child[name] = value;
  }
  child[DEPTH_ENV] = String(readDepth(env) + 1);
  child[PARENT_ENV] = "codex";
  return child;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/env.test.mjs`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/lib/env.mjs tests/env.test.mjs
git commit -m "feat(companion): nesting guard and scrubbed child environment

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Workspace root and state store (`lib/workspace.mjs`, `lib/state.mjs`)

**Files:**
- Create: `plugins/claude/scripts/lib/workspace.mjs`
- Create: `plugins/claude/scripts/lib/state.mjs`
- Create: `tests/helpers.mjs`
- Test: `tests/state.test.mjs`

**Interfaces:**
- Consumes: `runCommand` from Task 3.
- Produces (workspace): `resolveWorkspaceRoot(cwd: string) → string` (git top-level or `cwd`).
- Produces (state): `STATE_DIR_ENV = "CLAUDE_COMPANION_STATE_DIR"`, `MAX_JOBS = 50`; `resolveStateRoot(env)`, `resolveStateDir(workspaceRoot, env)`, `resolveStateFile(workspaceRoot, env)`, `resolveJobsDir(workspaceRoot, env)`, `resolveJobFile(workspaceRoot, jobId, env)`, `resolveJobLogFile(workspaceRoot, jobId, env)`, `ensureStateDir(workspaceRoot, env)`; `loadState(workspaceRoot, env) → { version: 1, lastSession: null|{sessionId, createdAt, cwd, promptExcerpt}, jobs: Job[] }`; `saveState(workspaceRoot, state, env) → state`; `updateState(workspaceRoot, mutate, env) → state`; `upsertJob(workspaceRoot, patch: {id, ...}, env) → Job`; `listJobs(workspaceRoot, env) → Job[]`; `getJob(workspaceRoot, jobId, env) → Job|null`; `setLastSession(workspaceRoot, {sessionId, cwd, promptExcerpt}, env)`; `getLastSession(workspaceRoot, env)`; `writeJobFile(workspaceRoot, jobId, data, env)`; `readJobFile(workspaceRoot, jobId, env) → object|null`; `generateJobId(now?: number) → string` like `job-<base36 ms>-<4 hex>`.
- Produces (helpers): `makeTempDir(prefix) → string`, `makeGitRepo(dir) → void` (init + one commit), `cleanEnv() → env` (process.env minus every `CLAUDE*`, `CODEX_COMPANION_*`, `FAKE_CLAUDE_*` variable), `withStateDir(env?) → env` (sets `CLAUDE_COMPANION_STATE_DIR` to a fresh temp dir), `FAKE_CLAUDE_CMD` (string; defined here, fixture arrives in Task 7), `ROOT`, `ENTRY` (absolute path of `claude-companion.mjs`).

Job record fields (all set by later tasks, but the store treats them opaquely): `id`, `kind` (`task`|`review`), `status` (`queued`|`running`|`succeeded`|`failed`|`cancelled`), `pid`, `createdAt`, `updatedAt`, `finishedAt`, `cwd`, `promptExcerpt`, `sessionId`, `logFile`, `exitCode`, `error`, `summary`, `background`.

- [ ] **Step 1: Write `tests/helpers.mjs`**

```js
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
```

- [ ] **Step 2: Write the failing tests**

`tests/state.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspaceRoot } from "../plugins/claude/scripts/lib/workspace.mjs";
import {
  resolveStateDir, loadState, upsertJob, listJobs, getJob, setLastSession, getLastSession,
  generateJobId, writeJobFile, readJobFile, resolveJobFile, MAX_JOBS
} from "../plugins/claude/scripts/lib/state.mjs";
import { makeTempDir, makeGitRepo, withStateDir, realpath } from "./helpers.mjs";

test("resolveWorkspaceRoot returns cwd outside git and repo root inside", () => {
  const plain = makeTempDir();
  assert.equal(realpath(resolveWorkspaceRoot(plain)), realpath(plain));
  const repo = makeTempDir();
  makeGitRepo(repo);
  const nested = path.join(repo, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(realpath(resolveWorkspaceRoot(nested)), realpath(repo));
});

test("state dir is derived from the env override, slug, and a 16-hex hash", () => {
  const env = withStateDir();
  const ws = makeTempDir("my repo-");
  const dir = resolveStateDir(ws, env);
  assert.ok(dir.startsWith(env.CLAUDE_COMPANION_STATE_DIR));
  assert.match(path.basename(dir), /^my-repo-[0-9a-f]{16}$/);
});

test("loadState returns defaults when nothing is stored", () => {
  const env = withStateDir();
  assert.deepEqual(loadState(makeTempDir(), env), { version: 1, lastSession: null, jobs: [] });
});

test("upsertJob creates then merges by id", () => {
  const env = withStateDir();
  const ws = makeTempDir();
  const created = upsertJob(ws, { id: "job-a", kind: "task", status: "queued" }, env);
  assert.equal(created.status, "queued");
  assert.ok(created.updatedAt);
  const updated = upsertJob(ws, { id: "job-a", status: "running", pid: 42 }, env);
  assert.equal(updated.kind, "task");
  assert.equal(updated.pid, 42);
  assert.equal(listJobs(ws, env).length, 1);
  assert.equal(getJob(ws, "job-a", env).status, "running");
  assert.equal(getJob(ws, "nope", env), null);
});

test("saveState keeps only the newest MAX_JOBS and deletes pruned files", () => {
  const env = withStateDir();
  const ws = makeTempDir();
  for (let i = 0; i < MAX_JOBS + 5; i += 1) {
    const id = `job-${String(i).padStart(3, "0")}`;
    upsertJob(ws, { id, kind: "task", status: "succeeded", updatedAt: new Date(1_000_000 + i * 1000).toISOString() }, env);
    writeJobFile(ws, id, { id }, env);
  }
  const jobs = listJobs(ws, env);
  assert.equal(jobs.length, MAX_JOBS);
  assert.equal(jobs.some((j) => j.id === "job-000"), false);
  assert.equal(fs.existsSync(resolveJobFile(ws, "job-000", env)), false);
  assert.equal(fs.existsSync(resolveJobFile(ws, `job-${MAX_JOBS + 4}`, env)), true);
});

test("last session round-trips", () => {
  const env = withStateDir();
  const ws = makeTempDir();
  assert.equal(getLastSession(ws, env), null);
  setLastSession(ws, { sessionId: "s-1", cwd: ws, promptExcerpt: "hello" }, env);
  const last = getLastSession(ws, env);
  assert.equal(last.sessionId, "s-1");
  assert.match(last.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("job files round-trip and generateJobId is unique-ish", () => {
  const env = withStateDir();
  const ws = makeTempDir();
  writeJobFile(ws, "job-x", { id: "job-x", request: { prompt: "p" } }, env);
  assert.deepEqual(readJobFile(ws, "job-x", env), { id: "job-x", request: { prompt: "p" } });
  assert.equal(readJobFile(ws, "missing", env), null);
  assert.match(generateJobId(), /^job-[0-9a-z]+-[0-9a-f]{4}$/);
  assert.notEqual(generateJobId(), generateJobId());
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/state.test.mjs`
Expected: FAIL — cannot find module `workspace.mjs`.

- [ ] **Step 4: Implement `lib/workspace.mjs`**

```js
import path from "node:path";
import { runCommand } from "./process.mjs";

export function resolveWorkspaceRoot(cwd) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.error || result.status !== 0) {
    return cwd;
  }
  const top = result.stdout.trim();
  return top ? path.resolve(top) : cwd;
}
```

- [ ] **Step 5: Implement `lib/state.mjs`**

```js
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_DIR_ENV = "CLAUDE_COMPANION_STATE_DIR";
export const MAX_JOBS = 50;
const STATE_VERSION = 1;

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

export function ensureStateDir(workspaceRoot, env) {
  fs.mkdirSync(resolveJobsDir(workspaceRoot, env), { recursive: true });
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

export function saveState(workspaceRoot, state, env) {
  const previous = loadState(workspaceRoot, env);
  ensureStateDir(workspaceRoot, env);
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
  fs.writeFileSync(resolveStateFile(workspaceRoot, env), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function updateState(workspaceRoot, mutate, env) {
  const state = loadState(workspaceRoot, env);
  mutate(state);
  return saveState(workspaceRoot, state, env);
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
  fs.writeFileSync(resolveJobFile(workspaceRoot, jobId, env), `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/state.test.mjs`
Expected: 7 passing.

- [ ] **Step 7: Commit**

```bash
git add plugins/claude/scripts/lib/workspace.mjs plugins/claude/scripts/lib/state.mjs tests/helpers.mjs tests/state.test.mjs
git commit -m "feat(companion): workspace resolution and per-workspace state store

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Claude adapter, pure parts (`lib/claude.mjs`)

**Files:**
- Create: `plugins/claude/scripts/lib/claude.mjs`
- Test: `tests/claude.test.mjs`

**Interfaces:**
- Consumes: `resolveCommandSpec` (Task 3).
- Produces: `CLAUDE_CMD_ENV = "CLAUDE_COMPANION_CLAUDE_CMD"`, `PROMPT_VIA_ARGV_ENV = "CLAUDE_COMPANION_PROMPT_VIA_ARGV"`, `VALID_EFFORTS = ["low","medium","high","xhigh","max"]`, `READ_ONLY_DISALLOWED = "Edit,Write,MultiEdit,NotebookEdit"`; `resolveWindowsClaude(whereOutput: string, existsSync) → { command, args, shell } | null` (pure); `resolveClaudeCommand(env, { platform?, where? }) → { command: string, args: string[], shell: boolean }`; `buildClaudeArgs({ permission, allow, resumeSessionId, model, effort, maxTurns, maxBudgetUsd, addDirs, name, appendSystemPrompt, jsonSchema, promptViaArgv }) → string[]`; `parseResultEnvelope(stdout) → { envelope: object|null, error: string|null }`; `classifyFailure({ envelope, status, signal, stderr, stdout, timedOut, timeoutMs, error }) → { kind: "missing"|"nested"|"timeout"|"auth"|"api"|"exit"|"parse", message: string } | null`.
- The async runner and probes are added in Task 7 to the same file.

- [ ] **Step 1: Write the failing tests**

`tests/claude.test.mjs`:

```js
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

test("read-only args deny edits and never skip permissions", () => {
  const args = buildClaudeArgs({ permission: "read" });
  assert.deepEqual(args.slice(0, 3), ["-p", "--output-format", "json"]);
  assert.ok(has(args, "--permission-mode", "dontAsk"));
  assert.ok(has(args, "--disallowedTools", READ_ONLY_DISALLOWED));
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
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

test("promptViaArgv places the prompt last", () => {
  const args = buildClaudeArgs({ permission: "read", promptViaArgv: "hello world" });
  assert.equal(args[args.length - 1], "hello world");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/claude.test.mjs`
Expected: FAIL — cannot find module `claude.mjs`.

- [ ] **Step 3: Implement the pure parts of `lib/claude.mjs`**

```js
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveCommandSpec, runCommand } from "./process.mjs";

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
    const cliJs = path.join(path.dirname(cmd), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
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
      const detail = tail(run.stderr) || tail(run.stdout);
      return { kind: "exit", message: `claude exited with code ${run.status}${run.signal ? ` (${run.signal})` : ""}.${detail ? `\n${detail}` : ""}` };
    }
    return { kind: "parse", message: `Claude produced no JSON result envelope.${tail(run.stdout) ? `\n${tail(run.stdout)}` : ""}` };
  }
  if (run.status !== 0 && run.status != null) {
    return { kind: "exit", message: `claude exited with code ${run.status} after producing a result.${tail(run.stderr) ? `\n${tail(run.stderr)}` : ""}` };
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/claude.test.mjs`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/lib/claude.mjs tests/claude.test.mjs
git commit -m "feat(companion): claude argv builder, envelope parser, failure classifier

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Fake claude fixture, async runner, availability and auth probes

**Files:**
- Create: `tests/fixtures/fake-claude.mjs`
- Modify: `plugins/claude/scripts/lib/claude.mjs` (append)
- Test: `tests/claude-run.test.mjs`

**Interfaces:**
- Consumes: `resolveClaudeCommand`, `parseResultEnvelope` (Task 6); `binaryAvailable`, `runCommand`, `terminateProcessTree` (Task 3); `buildChildEnv` (Task 4).
- Produces: `runClaude({ cwd, env, prompt, claudeArgs, timeoutMs = 0, onSpawn? }) → Promise<{ pid, status, signal, stdout, stderr, timedOut, error }>` — resolves the command, builds the child env with `buildChildEnv`, writes `prompt` to stdin unless `env[PROMPT_VIA_ARGV_ENV] === "1"` (then appends it to argv), and kills the tree on timeout; `getClaudeAvailability(env) → { available, detail }`; `getClaudeAuthStatus(env) → { loggedIn: boolean, detail: string }`.
- Fixture contract (`FAKE_CLAUDE_MODE`): `ok` (default), `structured`, `auth-error` (exit 1, `is_error`), `slow` (sleeps `FAKE_CLAUDE_SLEEP_MS`, default 3000), `denied` (one Edit denial), `garbage` (non-JSON stdout). `--version` prints `2.1.238 (Claude Code)`. `auth status` prints `{"loggedIn":…}` and exits 0/1 from `FAKE_CLAUDE_LOGGED_IN` (default `true`). Every envelope carries `fake: { argv, stdinLength, stdinHead, depth, claudecode, cwd }`. `FAKE_CLAUDE_RESULT` and `FAKE_CLAUDE_SESSION_ID` override the answer and session id.

- [ ] **Step 1: Write the fixture**

`tests/fixtures/fake-claude.mjs`:

```js
#!/usr/bin/env node
import process from "node:process";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";

if (argv[0] === "--version") {
  console.log("2.1.238 (Claude Code)");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  const loggedIn = (process.env.FAKE_CLAUDE_LOGGED_IN ?? "true") === "true";
  console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? "oauth" : "none", apiProvider: "firstParty" }));
  process.exit(loggedIn ? 0 : 1);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const stdin = await readStdin();
const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? (mode === "slow" ? 3000 : 0));
if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));

if (mode === "garbage") {
  console.log("this is not json");
  process.exit(0);
}

const envelope = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: process.env.FAKE_CLAUDE_SESSION_ID ?? "11111111-1111-4111-8111-111111111111",
  num_turns: 2,
  total_cost_usd: 0.0123,
  duration_ms: 5,
  permission_denials: [],
  result: process.env.FAKE_CLAUDE_RESULT ?? `fake answer for: ${stdin.slice(0, 80)}`,
  fake: {
    argv,
    stdinLength: stdin.length,
    stdinHead: stdin.slice(0, 200),
    depth: process.env.CLAUDE_COMPANION_DEPTH ?? null,
    claudecode: process.env.CLAUDECODE ?? null,
    cwd: process.cwd()
  }
};

if (mode === "auth-error") {
  envelope.is_error = true;
  envelope.result = "Failed to authenticate: OAuth session expired and could not be refreshed";
  console.log("some noise before the envelope");
  console.log(JSON.stringify(envelope));
  process.exit(1);
}
if (mode === "denied") {
  envelope.permission_denials = [{ tool_name: "Edit", tool_input: { file_path: "src/a.js" } }];
}
if (mode === "structured") {
  envelope.structured_output = {
    verdict: "needs-attention",
    summary: "One real bug.",
    findings: [
      { severity: "low", title: "Nit", body: "minor", file: "src/b.js", line_start: 1, line_end: 1, confidence: 0.5, recommendation: "optional" },
      { severity: "high", title: "Null deref", body: "x may be null", file: "src/a.js", line_start: 10, line_end: 12, confidence: 0.9, recommendation: "guard it" }
    ],
    next_steps: ["Add a null guard"]
  };
}
console.log(JSON.stringify(envelope));
```

- [ ] **Step 2: Write the failing tests**

`tests/claude-run.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runClaude, getClaudeAvailability, getClaudeAuthStatus, parseResultEnvelope, buildClaudeArgs } from "../plugins/claude/scripts/lib/claude.mjs";
import { FAKE_CLAUDE_CMD, cleanEnv, makeTempDir } from "./helpers.mjs";

const baseEnv = (extra = {}) => ({ ...cleanEnv(), CLAUDE_COMPANION_CLAUDE_CMD: FAKE_CLAUDE_CMD, ...extra });

test("runClaude delivers the prompt on stdin and scrubs the env", async () => {
  const cwd = makeTempDir();
  const prompt = "explain the auth flow";
  const run = await runClaude({ cwd, env: baseEnv({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x" }), prompt, claudeArgs: buildClaudeArgs({ permission: "read" }) });
  assert.equal(run.status, 0);
  const { envelope } = parseResultEnvelope(run.stdout);
  assert.equal(envelope.fake.stdinLength, prompt.length);
  assert.equal(envelope.fake.claudecode, null);
  assert.equal(envelope.fake.depth, "1");
  assert.ok(envelope.fake.argv.includes("dontAsk"));
});

test("runClaude can pass the prompt in argv when asked", async () => {
  const run = await runClaude({ cwd: makeTempDir(), env: baseEnv({ CLAUDE_COMPANION_PROMPT_VIA_ARGV: "1" }), prompt: "hi there", claudeArgs: buildClaudeArgs({ permission: "read" }) });
  const { envelope } = parseResultEnvelope(run.stdout);
  assert.equal(envelope.fake.argv.at(-1), "hi there");
  assert.equal(envelope.fake.stdinLength, 0);
});

test("runClaude surfaces auth errors with exit status 1", async () => {
  const run = await runClaude({ cwd: makeTempDir(), env: baseEnv({ FAKE_CLAUDE_MODE: "auth-error" }), prompt: "x", claudeArgs: [] });
  assert.equal(run.status, 1);
  assert.equal(parseResultEnvelope(run.stdout).envelope.is_error, true);
});

test("runClaude enforces the timeout", async () => {
  const run = await runClaude({ cwd: makeTempDir(), env: baseEnv({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLEEP_MS: "5000" }), prompt: "x", claudeArgs: [], timeoutMs: 400 });
  assert.equal(run.timedOut, true);
});

test("runClaude reports a missing binary", async () => {
  const run = await runClaude({ cwd: makeTempDir(), env: { ...cleanEnv(), CLAUDE_COMPANION_CLAUDE_CMD: "definitely-not-a-binary-xyz" }, prompt: "x", claudeArgs: [] });
  assert.equal(run.error?.code, "ENOENT");
});

test("availability and auth probes read the fixture", () => {
  assert.deepEqual(getClaudeAvailability(baseEnv()), { available: true, detail: "2.1.238 (Claude Code)" });
  assert.equal(getClaudeAuthStatus(baseEnv()).loggedIn, true);
  assert.equal(getClaudeAuthStatus(baseEnv({ FAKE_CLAUDE_LOGGED_IN: "false" })).loggedIn, false);
  assert.equal(getClaudeAvailability({ ...cleanEnv(), CLAUDE_COMPANION_CLAUDE_CMD: "definitely-not-a-binary-xyz" }).available, false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/claude-run.test.mjs`
Expected: FAIL — `runClaude` is not exported.

- [ ] **Step 4: Append the runner and probes to `lib/claude.mjs`**

Add these imports at the top of the file: `import { spawn } from "node:child_process";`, `import { binaryAvailable, terminateProcessTree } from "./process.mjs";` (merge with the existing `process.mjs` import), `import { buildChildEnv } from "./env.mjs";`. Then append:

```js
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/claude-run.test.mjs tests/claude.test.mjs`
Expected: 15 passing. The timeout test must finish in well under 5 s; if it hangs on Windows, confirm `terminateProcessTree` reached `taskkill`.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/fake-claude.mjs plugins/claude/scripts/lib/claude.mjs tests/claude-run.test.mjs
git commit -m "feat(companion): async claude runner with timeout, probes, and fake binary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Review target and context (`lib/git.mjs`)

**Files:**
- Create: `plugins/claude/scripts/lib/git.mjs`
- Test: `tests/git.test.mjs`

**Interfaces:**
- Consumes: `runCommand` (Task 3), `makeGitRepo`/`makeTempDir` (Task 5 helpers).
- Produces: `isGitRepository(cwd) → boolean`; `isDirty(cwd) → boolean`; `detectBaseRef(cwd) → string|null`; `resolveReviewTarget(cwd, { scope = "auto", base = null }) → { mode: "working-tree"|"branch", baseRef: string|null, label: string }` (throws `Not a git repository` / `No base branch found; pass --base <ref>`); `collectReviewContext(cwd, target, { maxInlineBytes = 262144, maxUntrackedBytes = 24576 }) → { text: string, files: string[], truncated: boolean }`.

- [ ] **Step 1: Write the failing tests**

`tests/git.test.mjs`:

```js
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

test("non-git directories are rejected", () => {
  assert.throws(() => resolveReviewTarget(makeTempDir()), /Not a git repository/);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/git.test.mjs`
Expected: FAIL — cannot find module `git.mjs`.

- [ ] **Step 3: Implement `lib/git.mjs`**

```js
import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./process.mjs";

const DEFAULT_MAX_INLINE_BYTES = 256 * 1024;
const DEFAULT_MAX_UNTRACKED_BYTES = 24 * 1024;

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

function isProbablyText(buffer) {
  return !buffer.subarray(0, 8000).includes(0);
}

export function isGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return !result.error && result.status === 0 && result.stdout.trim() === "true";
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
  if (!isGitRepository(cwd)) {
    throw new Error(`Not a git repository: ${cwd}`);
  }
  const scope = options.scope ?? "auto";
  const explicitBase = options.base ?? null;
  const wantsBranch = scope === "branch" || (scope === "auto" && (explicitBase || !isDirty(cwd)));
  if (scope === "working-tree" || !wantsBranch) {
    return { mode: "working-tree", baseRef: null, label: "working tree" };
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

function listStatusFiles(statusOutput) {
  return [...new Set(statusOutput.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim().replace(/^.* -> /, "")))].sort();
}

function collectUntracked(cwd, maxUntrackedBytes) {
  const untracked = gitOut(cwd, ["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean);
  const blocks = [];
  for (const relative of untracked) {
    const absolute = path.join(cwd, relative);
    let buffer;
    try {
      if (fs.statSync(absolute).size > maxUntrackedBytes) continue;
      buffer = fs.readFileSync(absolute);
    } catch {
      continue;
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
    diff = gitOut(cwd, ["diff", "HEAD"]);
    extra = collectUntracked(cwd, maxUntrackedBytes);
    files = listStatusFiles(status);
    statArgs = ["diff", "--stat", "HEAD"];
  } else {
    const mergeBase = gitOut(cwd, ["merge-base", "HEAD", target.baseRef]).trim();
    const log = gitOut(cwd, ["log", "--oneline", `${mergeBase}..HEAD`]);
    header = `Commits since ${target.baseRef}:\n${log.trim() || "(none)"}`;
    diff = gitOut(cwd, ["diff", `${target.baseRef}...HEAD`]);
    files = gitOut(cwd, ["diff", "--name-only", `${target.baseRef}...HEAD`]).split(/\r?\n/).filter(Boolean).sort();
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/git.test.mjs`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/lib/git.mjs tests/git.test.mjs
git commit -m "feat(companion): review target resolution and git context collection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Prompt templates and builder (`lib/prompts.mjs`, `prompts/*.md`)

**Files:**
- Create: `plugins/claude/prompts/codex-context.md`
- Create: `plugins/claude/prompts/review.md`
- Create: `plugins/claude/prompts/adversarial-review.md`
- Create: `plugins/claude/scripts/lib/prompts.mjs`
- Test: `tests/prompts.test.mjs`

**Interfaces:**
- Produces: `loadPromptTemplate(rootDir, name) → string` (reads `<rootDir>/prompts/<name>.md`); `interpolateTemplate(template, vars) → string` (replaces `{{KEY}}`, missing keys become empty); `loadCodexContext(rootDir) → string`; `buildReviewPrompt(rootDir, { adversarial: boolean, targetLabel: string, focus: string, context: string }) → string`. `rootDir` is always the plugin root (`plugins/claude`).

- [ ] **Step 1: Write the failing tests**

`tests/prompts.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { interpolateTemplate, loadCodexContext, buildReviewPrompt } from "../plugins/claude/scripts/lib/prompts.mjs";
import { ROOT } from "./helpers.mjs";

const PLUGIN_ROOT = path.join(ROOT, "plugins", "claude");

test("interpolateTemplate replaces known keys and blanks unknown ones", () => {
  assert.equal(interpolateTemplate("a {{X}} b {{Y}}", { X: "1" }), "a 1 b ");
});

test("codex context forbids delegating back to Codex and asking questions", () => {
  const text = loadCodexContext(PLUGIN_ROOT);
  assert.match(text, /invoked by OpenAI Codex/);
  assert.match(text, /codex-rescue/);
  assert.match(text, /Do not ask/);
});

test("review prompts embed target, focus, context and demand schema JSON", () => {
  const normal = buildReviewPrompt(PLUGIN_ROOT, { adversarial: false, targetLabel: "working tree", focus: "auth", context: "DIFF-HERE" });
  assert.match(normal, /Target: working tree/);
  assert.match(normal, /User focus: auth/);
  assert.match(normal, /DIFF-HERE/);
  assert.match(normal, /needs-attention/);
  const adversarial = buildReviewPrompt(PLUGIN_ROOT, { adversarial: true, targetLabel: "branch vs main", focus: "", context: "X" });
  assert.match(adversarial, /adversarial/i);
  assert.match(adversarial, /User focus: \(none\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompts.test.mjs`
Expected: FAIL — cannot find module `prompts.mjs`.

- [ ] **Step 3: Write the templates**

`plugins/claude/prompts/codex-context.md`:

```markdown
You were invoked by OpenAI Codex through the codex-claude-plugin companion, not by a person at a terminal. The calling agent reads only your final message.

- Nobody can answer questions during this run. Do not ask for clarification or permission; state your assumptions and proceed.
- Do not delegate back to Codex. Never use the codex plugin, any /codex:* command, or the codex-rescue subagent; that would create a loop between the two agents.
- If a tool call is denied, do not work around the denial. Note what you could not do and finish.
- End with a self-contained final message: what you found or changed, the files involved, and any remaining risks or next steps.
```

`plugins/claude/prompts/review.md`:

```markdown
<role>
You are Claude Code performing a code review requested by OpenAI Codex on behalf of the user.
</role>

<task>
Review the repository changes described below.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<review_method>
Read the provided diff first. You have read-only file tools: open surrounding code, callers, and tests whenever the diff alone cannot settle a question. Do not modify files.
Prioritise correctness bugs, security issues, data loss, broken invariants, unhandled failure paths, and missing tests for risky behaviour. Skip style-only feedback.
If the user supplied a focus, weight it heavily but still report any other material issue.
</review_method>

<structured_output_contract>
Return only valid JSON matching the provided schema.
Use `needs-attention` when any finding should block or change the change; use `approve` only when you found nothing material.
Every finding must name the affected file, `line_start` and `line_end`, a confidence from 0 to 1, and a concrete recommendation.
Keep the summary to a terse ship/no-ship assessment.
</structured_output_contract>

<grounding_rules>
Every finding must be defensible from the diff or from files you actually read. Do not invent files, lines, or behaviour. When a conclusion rests on inference, say so in the body and keep the confidence honest.
</grounding_rules>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
```

`plugins/claude/prompts/adversarial-review.md`:

```markdown
<role>
You are Claude Code performing an adversarial software review requested by OpenAI Codex. Your job is to break confidence in the change, not to validate it.
</role>

<task>
Review the repository changes below as if you are trying to find the strongest reasons this change should not ship yet.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<operating_stance>
Default to skepticism. Assume the change can fail in subtle, high-cost, or user-visible ways until the evidence says otherwise. Do not give credit for good intent, partial fixes, or likely follow-up work. Happy-path-only behaviour is a real weakness.
</operating_stance>

<attack_surface>
Prioritise failures that are expensive, dangerous, or hard to detect: auth, permissions, and trust boundaries; data loss, corruption, duplication, and irreversible state changes; rollback safety, retries, partial failure, and idempotency gaps; races, ordering assumptions, stale state, and re-entrancy; empty-state, null, timeout, and degraded-dependency behaviour; version skew, schema drift, migration hazards; observability gaps that would hide failure.
</attack_surface>

<review_method>
Actively try to disprove the change. You have read-only file tools: trace how bad inputs, retries, concurrent actions, or partially completed operations move through the code by reading callers and tests. Do not modify files.
</review_method>

<finding_bar>
Report only material findings. Each must answer: what can go wrong, why this code path is vulnerable, the likely impact, and the concrete change that reduces the risk. Prefer one strong finding over several weak ones. If the change looks safe, say so and return no findings.
</finding_bar>

<structured_output_contract>
Return only valid JSON matching the provided schema. Use `needs-attention` if there is any material risk worth blocking on; use `approve` only if you cannot support a substantive adversarial finding. Every finding needs the affected file, `line_start` and `line_end`, a confidence from 0 to 1, and a concrete recommendation. Write the summary as a terse ship/no-ship assessment.
</structured_output_contract>

<grounding_rules>
Be aggressive but grounded. Every finding must be defensible from the diff or files you actually read. Do not invent files, lines, code paths, incidents, or runtime behaviour. State inferences explicitly and keep confidence honest.
</grounding_rules>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
```

- [ ] **Step 4: Implement `lib/prompts.mjs`**

```js
import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  return fs.readFileSync(path.join(rootDir, "prompts", `${name}.md`), "utf8");
}

export function interpolateTemplate(template, vars = {}) {
  return String(template).replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => String(vars[key] ?? ""));
}

export function loadCodexContext(rootDir) {
  return loadPromptTemplate(rootDir, "codex-context").trim();
}

export function buildReviewPrompt(rootDir, { adversarial = false, targetLabel, focus = "", context }) {
  const template = loadPromptTemplate(rootDir, adversarial ? "adversarial-review" : "review");
  return interpolateTemplate(template, {
    TARGET_LABEL: targetLabel,
    USER_FOCUS: String(focus ?? "").trim() || "(none)",
    REVIEW_INPUT: context
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/prompts.test.mjs`
Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
git add plugins/claude/prompts plugins/claude/scripts/lib/prompts.mjs tests/prompts.test.mjs
git commit -m "feat(companion): prompt templates and review prompt builder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Job lifecycle, foreground (`lib/jobs.mjs`)

**Files:**
- Create: `plugins/claude/scripts/lib/jobs.mjs`
- Test: `tests/jobs.test.mjs`

**Interfaces:**
- Consumes: state functions (Task 5); `runClaude`, `parseResultEnvelope`, `classifyFailure` (Tasks 6–7).
- Produces: `excerpt(text, limit = 96) → string`; `createJob(workspaceRoot, { kind, cwd, promptExcerpt, background, request }, env) → Job` where `request = { prompt: string, claudeArgs: string[], timeoutMs: number, structured: boolean, targetLabel: string|null }`; `executeJob(workspaceRoot, jobId, env) → Promise<Payload>`; `buildPayload({ kind, cwd, jobId, run, envelope, failure, targetLabel }) → Payload`.
- `Payload = { ok: boolean, command: "task"|"review", cwd, jobId, sessionId: string|null, numTurns: number|null, costUsd: number|null, durationMs: number|null, result: string, structuredOutput: object|null, permissionDenials: Array<{tool_name, tool_input}>, targetLabel: string|null, error: {kind, message}|null, stderr: string }`.

- [ ] **Step 1: Write the failing tests**

`tests/jobs.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJob, executeJob, excerpt } from "../plugins/claude/scripts/lib/jobs.mjs";
import { getJob, getLastSession, readJobFile } from "../plugins/claude/scripts/lib/state.mjs";
import { buildClaudeArgs } from "../plugins/claude/scripts/lib/claude.mjs";
import { FAKE_CLAUDE_CMD, makeTempDir, withStateDir } from "./helpers.mjs";

const envFor = (extra = {}) => withStateDir({ CLAUDE_COMPANION_CLAUDE_CMD: FAKE_CLAUDE_CMD, ...extra });
const request = (overrides = {}) => ({ prompt: "explain auth", claudeArgs: buildClaudeArgs({ permission: "read" }), timeoutMs: 10000, structured: false, targetLabel: null, ...overrides });

test("excerpt collapses whitespace and truncates", () => {
  assert.equal(excerpt("  a   b\n c "), "a b c");
  assert.equal(excerpt("x".repeat(200), 10), "xxxxxxx...");
});

test("createJob records a queued job and writes the request file", () => {
  const env = envFor();
  const ws = makeTempDir();
  const job = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "explain auth", background: false, request: request() }, env);
  assert.match(job.id, /^job-/);
  assert.equal(getJob(ws, job.id, env).status, "queued");
  assert.equal(readJobFile(ws, job.id, env).request.prompt, "explain auth");
});

test("executeJob succeeds, stores the payload, and remembers the session for tasks", async () => {
  const env = envFor({ FAKE_CLAUDE_SESSION_ID: "sess-42" });
  const ws = makeTempDir();
  const job = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "explain auth", background: false, request: request() }, env);
  const payload = await executeJob(ws, job.id, env);
  assert.equal(payload.ok, true);
  assert.equal(payload.sessionId, "sess-42");
  assert.match(payload.result, /fake answer for: explain auth/);
  assert.equal(getJob(ws, job.id, env).status, "succeeded");
  assert.equal(getLastSession(ws, env).sessionId, "sess-42");
  assert.equal(readJobFile(ws, job.id, env).result.ok, true);
});

test("review jobs keep structured output and never touch lastSession", async () => {
  const env = envFor({ FAKE_CLAUDE_MODE: "structured" });
  const ws = makeTempDir();
  const job = createJob(ws, { kind: "review", cwd: ws, promptExcerpt: "review", background: false, request: request({ structured: true, targetLabel: "working tree" }) }, env);
  const payload = await executeJob(ws, job.id, env);
  assert.equal(payload.structuredOutput.verdict, "needs-attention");
  assert.equal(payload.targetLabel, "working tree");
  assert.equal(getLastSession(ws, env), null);
});

test("auth failures mark the job failed with an actionable error", async () => {
  const env = envFor({ FAKE_CLAUDE_MODE: "auth-error" });
  const ws = makeTempDir();
  const job = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "x", background: false, request: request() }, env);
  const payload = await executeJob(ws, job.id, env);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.kind, "auth");
  const stored = getJob(ws, job.id, env);
  assert.equal(stored.status, "failed");
  assert.match(stored.error, /claude auth login/);
});

test("timeouts fail the job and denials are reported", async () => {
  const slowEnv = envFor({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLEEP_MS: "5000" });
  const ws = makeTempDir();
  const slow = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "x", background: false, request: request({ timeoutMs: 400 }) }, slowEnv);
  const slowPayload = await executeJob(ws, slow.id, slowEnv);
  assert.equal(slowPayload.error.kind, "timeout");
  const deniedEnv = envFor({ FAKE_CLAUDE_MODE: "denied" });
  const denied = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "x", background: false, request: request() }, deniedEnv);
  const deniedPayload = await executeJob(ws, denied.id, deniedEnv);
  assert.equal(deniedPayload.ok, true);
  assert.equal(deniedPayload.permissionDenials[0].tool_name, "Edit");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/jobs.test.mjs`
Expected: FAIL — cannot find module `jobs.mjs`.

- [ ] **Step 3: Implement `lib/jobs.mjs` (foreground part)**

```js
import process from "node:process";
import { classifyFailure, parseResultEnvelope, runClaude } from "./claude.mjs";
import {
  generateJobId, getJob, readJobFile, resolveJobLogFile, setLastSession, upsertJob, writeJobFile
} from "./state.mjs";

function nowIso() {
  return new Date().toISOString();
}

export function excerpt(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function tail(text, limit = 20) {
  return String(text ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-limit).join("\n");
}

export function createJob(workspaceRoot, { kind, cwd, promptExcerpt, background = false, request }, env = process.env) {
  const id = generateJobId();
  const job = upsertJob(workspaceRoot, {
    id,
    kind,
    status: "queued",
    pid: null,
    workerPid: null,
    cwd,
    promptExcerpt: excerpt(promptExcerpt),
    sessionId: null,
    logFile: resolveJobLogFile(workspaceRoot, id, env),
    finishedAt: null,
    exitCode: null,
    error: null,
    summary: null,
    background
  }, env);
  writeJobFile(workspaceRoot, id, { ...job, request, result: null }, env);
  return job;
}

export function buildPayload({ kind, cwd, jobId, run, envelope, failure, targetLabel = null }) {
  return {
    ok: !failure,
    command: kind,
    cwd,
    jobId,
    sessionId: envelope?.session_id ?? null,
    numTurns: envelope?.num_turns ?? null,
    costUsd: envelope?.total_cost_usd ?? null,
    durationMs: envelope?.duration_ms ?? null,
    result: failure ? "" : String(envelope?.result ?? ""),
    structuredOutput: envelope?.structured_output ?? null,
    permissionDenials: Array.isArray(envelope?.permission_denials) ? envelope.permission_denials : [],
    targetLabel,
    error: failure ?? null,
    stderr: tail(run?.stderr)
  };
}

export async function executeJob(workspaceRoot, jobId, env = process.env) {
  const stored = readJobFile(workspaceRoot, jobId, env);
  const job = getJob(workspaceRoot, jobId, env);
  if (!stored?.request || !job) {
    throw new Error(`Job ${jobId} has no stored request.`);
  }
  const { request } = stored;
  upsertJob(workspaceRoot, { id: jobId, status: "running", startedAt: nowIso() }, env);

  const run = await runClaude({
    cwd: job.cwd,
    env,
    prompt: request.prompt,
    claudeArgs: request.claudeArgs,
    timeoutMs: request.timeoutMs ?? 0,
    onSpawn: (pid) => upsertJob(workspaceRoot, { id: jobId, pid }, env)
  });

  const { envelope } = parseResultEnvelope(run.stdout);
  const failure = classifyFailure({ ...run, envelope, timeoutMs: request.timeoutMs });
  const payload = buildPayload({ kind: job.kind, cwd: job.cwd, jobId, run, envelope, failure, targetLabel: request.targetLabel ?? null });

  if (!failure && job.kind === "task" && payload.sessionId) {
    setLastSession(workspaceRoot, { sessionId: payload.sessionId, cwd: job.cwd, promptExcerpt: job.promptExcerpt }, env);
  }

  const summary = failure ? failure.message.split(/\r?\n/)[0] : excerpt(payload.structuredOutput?.summary ?? payload.result, 120);
  upsertJob(workspaceRoot, {
    id: jobId,
    status: failure ? "failed" : "succeeded",
    finishedAt: nowIso(),
    exitCode: run.status,
    sessionId: payload.sessionId,
    error: failure ? failure.message : null,
    summary
  }, env);
  writeJobFile(workspaceRoot, jobId, { ...stored, ...getJob(workspaceRoot, jobId, env), request, result: payload }, env);
  return payload;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/jobs.test.mjs`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/lib/jobs.mjs tests/jobs.test.mjs
git commit -m "feat(companion): foreground job execution with payload and session tracking

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Background worker, cancel, status snapshot

**Files:**
- Modify: `plugins/claude/scripts/lib/jobs.mjs` (append)
- Create: `plugins/claude/scripts/claude-companion.mjs` (minimal: `__worker` only; Task 13 adds the rest)
- Test: `tests/jobs-background.test.mjs`

**Interfaces:**
- Consumes: Task 10 exports; `terminateProcessTree` (Task 3); `listJobs`, `getJob`, `upsertJob`, `readJobFile`, `resolveJobLogFile` (Task 5).
- Produces: `spawnBackgroundWorker(workspaceRoot, jobId, env, { entryPath }) → { pid }`; `cancelJob(workspaceRoot, jobId, env) → { ok: boolean, job: Job|null, message: string }`; `buildStatusSnapshot(workspaceRoot, { all = false }, env) → { running: Job[], latestFinished: Job|null, recent: Job[] }`; `resolveJobForResult(workspaceRoot, jobId|null, env) → { job: Job, result: Payload|null } | null`; `sortJobsNewestFirst(jobs) → Job[]`.
- Entry point contract for the worker: `node claude-companion.mjs __worker <job-id> --cwd <workspace-root>` runs `executeJob` and exits 0 on success, 1 on failure.

- [ ] **Step 1: Write the failing tests**

`tests/jobs-background.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJob, spawnBackgroundWorker, cancelJob, buildStatusSnapshot, resolveJobForResult } from "../plugins/claude/scripts/lib/jobs.mjs";
import { getJob, readJobFile } from "../plugins/claude/scripts/lib/state.mjs";
import { buildClaudeArgs } from "../plugins/claude/scripts/lib/claude.mjs";
import { ENTRY, FAKE_CLAUDE_CMD, makeTempDir, withStateDir } from "./helpers.mjs";

const envFor = (extra = {}) => withStateDir({ CLAUDE_COMPANION_CLAUDE_CMD: FAKE_CLAUDE_CMD, ...extra });
const request = (overrides = {}) => ({ prompt: "long task", claudeArgs: buildClaudeArgs({ permission: "read" }), timeoutMs: 60000, structured: false, targetLabel: null, ...overrides });

async function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("background job runs to completion in a detached worker", async () => {
  const env = envFor({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLEEP_MS: "800", FAKE_CLAUDE_RESULT: "done in background" });
  const ws = makeTempDir();
  const job = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "long task", background: true, request: request() }, env);
  const { pid } = spawnBackgroundWorker(ws, job.id, env, { entryPath: ENTRY });
  assert.ok(pid > 0);
  assert.equal(await waitFor(() => getJob(ws, job.id, env).status === "succeeded"), true, "job should succeed");
  assert.equal(readJobFile(ws, job.id, env).result.result, "done in background");
  assert.ok(fs.existsSync(job.logFile));
  const snapshot = buildStatusSnapshot(ws, {}, env);
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.latestFinished.id, job.id);
  assert.equal(resolveJobForResult(ws, null, env).result.result, "done in background");
});

test("cancel kills a running background job", async () => {
  const env = envFor({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLEEP_MS: "20000" });
  const ws = makeTempDir();
  const job = createJob(ws, { kind: "task", cwd: ws, promptExcerpt: "forever", background: true, request: request() }, env);
  spawnBackgroundWorker(ws, job.id, env, { entryPath: ENTRY });
  assert.equal(await waitFor(() => getJob(ws, job.id, env).pid != null), true, "claude pid should be recorded");
  assert.equal(buildStatusSnapshot(ws, {}, env).running.length, 1);
  const report = cancelJob(ws, job.id, env);
  assert.equal(report.ok, true);
  assert.equal(getJob(ws, job.id, env).status, "cancelled");
  const claudePid = getJob(ws, job.id, env).pid;
  const gone = await waitFor(() => {
    try { process.kill(claudePid, 0); return false; } catch { return true; }
  }, 5000);
  assert.equal(gone, true, "claude process should be gone");
  assert.equal(cancelJob(ws, job.id, env).ok, false);
  assert.equal(cancelJob(ws, "job-missing", env).ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/jobs-background.test.mjs`
Expected: FAIL — `spawnBackgroundWorker` is not exported.

- [ ] **Step 3: Append to `lib/jobs.mjs`**

Add `import fs from "node:fs";`, `import { spawn } from "node:child_process";`, `import { terminateProcessTree } from "./process.mjs";`, and extend the state import with `listJobs`. Then append:

```js
const ACTIVE = new Set(["queued", "running"]);

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

export function spawnBackgroundWorker(workspaceRoot, jobId, env = process.env, { entryPath }) {
  const job = getJob(workspaceRoot, jobId, env);
  if (!job) throw new Error(`Unknown job ${jobId}.`);
  const logFd = fs.openSync(job.logFile, "a");
  const child = spawn(process.execPath, [entryPath, "__worker", jobId, "--cwd", workspaceRoot], {
    cwd: job.cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true
  });
  child.unref();
  fs.closeSync(logFd);
  upsertJob(workspaceRoot, { id: jobId, workerPid: child.pid }, env);
  return { pid: child.pid };
}

export function cancelJob(workspaceRoot, jobId, env = process.env) {
  const job = getJob(workspaceRoot, jobId, env);
  if (!job) return { ok: false, job: null, message: `No job named ${jobId} in this workspace.` };
  if (!ACTIVE.has(job.status)) return { ok: false, job, message: `Job ${jobId} is already ${job.status}.` };
  const reports = [];
  for (const pid of [job.pid, job.workerPid]) {
    if (pid) reports.push(terminateProcessTree(pid));
  }
  const updated = upsertJob(workspaceRoot, { id: jobId, status: "cancelled", finishedAt: nowIso(), error: "Cancelled by user." }, env);
  const stored = readJobFile(workspaceRoot, jobId, env);
  if (stored) writeJobFile(workspaceRoot, jobId, { ...stored, ...updated }, env);
  const delivered = reports.some((report) => report.delivered);
  return { ok: true, job: updated, message: delivered ? `Cancelled job ${jobId}.` : `Marked job ${jobId} cancelled; no live process was found.` };
}

export function buildStatusSnapshot(workspaceRoot, { all = false } = {}, env = process.env) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot, env));
  const running = jobs.filter((job) => ACTIVE.has(job.status));
  const finished = jobs.filter((job) => !ACTIVE.has(job.status));
  return {
    running,
    latestFinished: finished[0] ?? null,
    recent: all ? finished : finished.slice(0, 10)
  };
}

export function resolveJobForResult(workspaceRoot, jobId, env = process.env) {
  const job = jobId ? getJob(workspaceRoot, jobId, env) : buildStatusSnapshot(workspaceRoot, {}, env).latestFinished;
  if (!job) return null;
  const stored = readJobFile(workspaceRoot, job.id, env);
  return { job, result: stored?.result ?? null };
}
```

- [ ] **Step 4: Create the minimal entry point**

`plugins/claude/scripts/claude-companion.mjs`:

```js
#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { parseArgs } from "./lib/args.mjs";
import { executeJob } from "./lib/jobs.mjs";

async function runWorker(argv) {
  const { options, positionals } = parseArgs(argv, { valueOptions: ["cwd"], aliasMap: { C: "cwd" } });
  const [jobId] = positionals;
  if (!jobId) throw new Error("Usage: claude-companion.mjs __worker <job-id> --cwd <workspace-root>");
  const workspaceRoot = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const payload = await executeJob(workspaceRoot, jobId, process.env);
  process.exitCode = payload.ok ? 0 : 1;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "__worker") {
    await runWorker(argv);
    return;
  }
  throw new Error(`Unknown command "${command ?? ""}".`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/jobs-background.test.mjs tests/jobs.test.mjs`
Expected: 8 passing, total under 15 s. If the cancel test leaves the fixture alive on Windows, confirm `taskkill /T` is reached with the claude pid; the worker's `detached: true` is required so `unref()` lets the test process exit.

- [ ] **Step 6: Commit**

```bash
git add plugins/claude/scripts/lib/jobs.mjs plugins/claude/scripts/claude-companion.mjs tests/jobs-background.test.mjs
git commit -m "feat(companion): background worker, cancel, and status snapshot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Text rendering (`lib/render.mjs`)

**Files:**
- Create: `plugins/claude/scripts/lib/render.mjs`
- Test: `tests/render.test.mjs`

**Interfaces:**
- Consumes: `Payload` (Task 10), `Job` (Task 5), snapshot/report shapes (Task 11), setup report shape (Task 13: `{ ready, node, claude, auth, nesting, nextSteps }`).
- Produces: `renderTaskResult(payload) → string`; `renderReviewResult(payload) → string`; `renderFailure(payload) → string`; `renderSetupReport(report) → string`; `renderStatusReport(snapshot) → string`; `renderJobDetails(job) → string`; `renderJobResult({ job, result }) → string`; `renderCancelReport(report) → string`; `renderBackgroundLaunch(job) → string`; `formatDuration(ms) → string`; `SEVERITY_ORDER = ["critical","high","medium","low"]`.
- Every renderer returns text ending in exactly one `\n`.

- [ ] **Step 1: Write the failing tests**

`tests/render.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderTaskResult, renderReviewResult, renderFailure, renderSetupReport, renderStatusReport, renderBackgroundLaunch, renderCancelReport, formatDuration
} from "../plugins/claude/scripts/lib/render.mjs";

const payload = (overrides = {}) => ({
  ok: true, command: "task", cwd: "/w", jobId: "job-1", sessionId: "sess-1", numTurns: 3, costUsd: 0.04567, durationMs: 1200,
  result: "The auth flow starts in login.ts.", structuredOutput: null, permissionDenials: [], targetLabel: null, error: null, stderr: "", ...overrides
});

test("task result is verbatim plus a trailer", () => {
  const text = renderTaskResult(payload());
  assert.ok(text.startsWith("The auth flow starts in login.ts.\n\n"));
  assert.match(text, /claude session sess-1 · 3 turns · \$0\.0457 · resume with --resume\n$/);
});

test("task trailer lists permission denials", () => {
  const text = renderTaskResult(payload({ permissionDenials: [{ tool_name: "Edit", tool_input: { file_path: "src/a.js" } }, { tool_name: "Bash", tool_input: { command: "npm test" } }] }));
  assert.match(text, /denied: Edit \(src\/a\.js\), Bash \(npm test\)/);
  assert.match(text, /--write or --allow/);
});

test("review findings are ordered by severity and end with next steps", () => {
  const text = renderReviewResult(payload({
    command: "review", targetLabel: "working tree",
    structuredOutput: {
      verdict: "needs-attention", summary: "One real bug.",
      findings: [
        { severity: "low", title: "Nit", body: "minor", file: "src/b.js", line_start: 1, line_end: 1, confidence: 0.5, recommendation: "optional" },
        { severity: "high", title: "Null deref", body: "x may be null", file: "src/a.js", line_start: 10, line_end: 12, confidence: 0.9, recommendation: "guard it" }
      ],
      next_steps: ["Add a null guard"]
    }
  }));
  assert.ok(text.startsWith("# Claude Review (working tree)\n"));
  assert.ok(text.indexOf("[HIGH] Null deref") < text.indexOf("[LOW] Nit"));
  assert.match(text, /src\/a\.js:10-12 \(confidence 0\.90\)/);
  assert.match(text, /Recommendation: guard it/);
  assert.match(text, /## Next steps\n- Add a null guard\n$/);
});

test("review with no findings and with unstructured output", () => {
  const clean = renderReviewResult(payload({ command: "review", targetLabel: "branch vs main", structuredOutput: { verdict: "approve", summary: "Fine.", findings: [], next_steps: [] } }));
  assert.match(clean, /No findings\./);
  const parsed = renderReviewResult(payload({ command: "review", targetLabel: "t", result: JSON.stringify({ verdict: "approve", summary: "S", findings: [], next_steps: [] }) }));
  assert.match(parsed, /Verdict: approve/);
  const raw = renderReviewResult(payload({ command: "review", targetLabel: "t", result: "just prose" }));
  assert.match(raw, /unstructured review output/);
  assert.match(raw, /just prose/);
});

test("failure rendering leads with the message and appends stderr", () => {
  const text = renderFailure(payload({ ok: false, error: { kind: "auth", message: "Claude is not logged in. Run `claude auth login`." }, stderr: "line1\nline2" }));
  assert.equal(text, "Claude is not logged in. Run `claude auth login`.\nline1\nline2\n");
});

test("setup, status, launch, cancel renderers", () => {
  const setup = renderSetupReport({
    ready: false, node: { available: true, detail: "v22.0.0" }, claude: { available: true, detail: "2.1.238 (Claude Code)" },
    auth: { loggedIn: false, detail: "not logged in" }, nesting: { nested: false, reason: null }, nextSteps: ["Run `claude auth login` in your own terminal."]
  });
  assert.match(setup, /Ready: no/);
  assert.match(setup, /1\. Run `claude auth login`/);
  const status = renderStatusReport({
    running: [{ id: "job-r", kind: "task", status: "running", createdAt: new Date(Date.now() - 65000).toISOString(), promptExcerpt: "long task" }],
    latestFinished: { id: "job-f", kind: "review", status: "succeeded", createdAt: "2026-09-04T00:00:00.000Z", finishedAt: "2026-09-04T00:00:30.000Z", summary: "Fine." },
    recent: []
  });
  assert.match(status, /job-r/);
  assert.match(status, /job-f/);
  assert.match(status, /result job-f/);
  assert.match(renderBackgroundLaunch({ id: "job-b", kind: "task" }), /job-b/);
  assert.match(renderCancelReport({ ok: true, message: "Cancelled job job-b." }), /Cancelled job job-b\./);
  assert.equal(formatDuration(65000), "1m 5s");
  assert.equal(formatDuration(900), "0.9s");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/render.test.mjs`
Expected: FAIL — cannot find module `render.mjs`.

- [ ] **Step 3: Implement `lib/render.mjs`**

```js
export const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

const COMPANION = "claude-companion.mjs";

function finish(lines) {
  return `${lines.join("\n").trimEnd()}\n`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function describeDenial(denial) {
  const input = denial?.tool_input ?? {};
  const detail = input.file_path ?? input.command ?? input.path ?? input.url ?? null;
  return detail ? `${denial.tool_name} (${detail})` : String(denial?.tool_name ?? "unknown tool");
}

function trailer(payload) {
  const cost = payload.costUsd == null ? "cost n/a" : `$${Number(payload.costUsd).toFixed(4)}`;
  const turns = payload.numTurns == null ? "? turns" : `${payload.numTurns} turns`;
  const lines = [`claude session ${payload.sessionId ?? "unknown"} · ${turns} · ${cost} · resume with --resume`];
  if (payload.permissionDenials?.length) {
    lines.push(`denied: ${payload.permissionDenials.map(describeDenial).join(", ")} — rerun with --write or --allow <rule> if Claude needed them`);
  }
  return lines;
}

export function renderTaskResult(payload) {
  const body = String(payload.result ?? "").trimEnd() || "(Claude returned an empty message.)";
  return finish([body, "", ...trailer(payload)]);
}

function coerceStructured(payload) {
  if (payload.structuredOutput && typeof payload.structuredOutput === "object") return payload.structuredOutput;
  try {
    const parsed = JSON.parse(String(payload.result ?? ""));
    if (parsed && typeof parsed === "object" && "verdict" in parsed) return parsed;
  } catch {
    // not JSON
  }
  return null;
}

export function renderReviewResult(payload) {
  const lines = [`# Claude Review (${payload.targetLabel ?? "unknown target"})`, ""];
  const review = coerceStructured(payload);
  if (!review) {
    lines.push("Claude returned unstructured review output:", "", String(payload.result ?? "").trimEnd());
    return finish(lines);
  }
  lines.push(`Verdict: ${review.verdict ?? "unknown"}`, `Summary: ${review.summary ?? ""}`, "", "## Findings", "");
  const findings = [...(review.findings ?? [])].sort(
    (a, b) => SEVERITY_ORDER.indexOf(String(a.severity)) - SEVERITY_ORDER.indexOf(String(b.severity))
  );
  if (findings.length === 0) {
    lines.push("No findings. Residual risk: only what the diff and inspected files could reveal.");
  }
  findings.forEach((finding, index) => {
    const range = finding.line_start === finding.line_end ? `${finding.line_start}` : `${finding.line_start}-${finding.line_end}`;
    lines.push(`${index + 1}. [${String(finding.severity ?? "").toUpperCase()}] ${finding.title} — ${finding.file}:${range} (confidence ${Number(finding.confidence ?? 0).toFixed(2)})`);
    lines.push(`   ${String(finding.body ?? "").replace(/\r?\n/g, "\n   ")}`);
    if (finding.recommendation) lines.push(`   Recommendation: ${finding.recommendation}`);
    lines.push("");
  });
  lines.push("## Next steps");
  const steps = review.next_steps ?? [];
  if (steps.length === 0) lines.push("- None.");
  for (const step of steps) lines.push(`- ${step}`);
  return finish(lines);
}

export function renderFailure(payload) {
  const lines = [payload.error?.message ?? "Claude did not run."];
  if (payload.stderr) lines.push(payload.stderr);
  return finish(lines);
}

export function renderSetupReport(report) {
  const yesNo = (value) => (value ? "yes" : "no");
  const lines = [
    "# Claude Companion Setup",
    "",
    `Ready: ${yesNo(report.ready)}`,
    `- node: ${report.node.available ? report.node.detail : `missing (${report.node.detail})`}`,
    `- claude: ${report.claude.available ? report.claude.detail : `missing (${report.claude.detail})`}`,
    `- login: ${report.auth.loggedIn ? report.auth.detail : `not logged in (${report.auth.detail})`}`,
    `- nesting: ${report.nesting.nested ? `blocked — ${report.nesting.reason}` : "clear"}`
  ];
  if (report.nextSteps?.length) {
    lines.push("", "Next steps:");
    report.nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }
  return finish(lines);
}

export function renderJobDetails(job, { showElapsed = false } = {}) {
  const started = Date.parse(job.startedAt ?? job.createdAt ?? "");
  const finished = Date.parse(job.finishedAt ?? "");
  const timing = showElapsed
    ? `elapsed ${formatDuration(Date.now() - started)}`
    : Number.isFinite(finished) && Number.isFinite(started) ? `took ${formatDuration(finished - started)}` : "";
  const lines = [`- ${job.id} · ${job.kind} · ${job.status}${timing ? ` · ${timing}` : ""}${job.background ? " · background" : ""}`];
  if (job.promptExcerpt) lines.push(`  prompt: ${job.promptExcerpt}`);
  if (job.summary) lines.push(`  summary: ${job.summary}`);
  if (job.error) lines.push(`  error: ${job.error}`);
  if (job.status === "succeeded" || job.status === "failed") lines.push(`  output: node ${COMPANION} result ${job.id}`);
  if (job.status === "running" || job.status === "queued") lines.push(`  stop: node ${COMPANION} cancel ${job.id}`);
  return lines.join("\n");
}

export function renderStatusReport(snapshot) {
  const lines = ["# Claude Jobs", ""];
  if (snapshot.running.length) {
    lines.push("Running:");
    for (const job of snapshot.running) lines.push(renderJobDetails(job, { showElapsed: true }));
    lines.push("");
  }
  if (snapshot.latestFinished) {
    lines.push("Latest finished:", renderJobDetails(snapshot.latestFinished), "");
  }
  const rest = snapshot.recent.filter((job) => job.id !== snapshot.latestFinished?.id);
  if (rest.length) {
    lines.push("Recent:");
    for (const job of rest) lines.push(renderJobDetails(job));
    lines.push("");
  }
  if (!snapshot.running.length && !snapshot.latestFinished) lines.push("No jobs recorded for this workspace yet.");
  return finish(lines);
}

export function renderJobResult({ job, result }) {
  const header = [`# Job ${job.id} (${job.status})`, ""];
  if (!result) {
    return finish([...header, job.error ? `Error: ${job.error}` : "No stored output for this job yet."]);
  }
  const body = !result.ok ? renderFailure(result) : result.command === "review" ? renderReviewResult(result) : renderTaskResult(result);
  return finish([...header, body.trimEnd()]);
}

export function renderCancelReport(report) {
  return finish([report.message]);
}

export function renderBackgroundLaunch(job) {
  return finish([
    `Started Claude ${job.kind} job ${job.id} in the background.`,
    `Progress: node ${COMPANION} status ${job.id}`,
    `Output:   node ${COMPANION} result ${job.id}`,
    `Stop:     node ${COMPANION} cancel ${job.id}`
  ]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/render.test.mjs`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/lib/render.mjs tests/render.test.mjs
git commit -m "feat(companion): text renderers for task, review, setup, status, jobs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: CLI entry point (`claude-companion.mjs`)

**Files:**
- Modify: `plugins/claude/scripts/claude-companion.mjs` (replace the Task 11 stub, keeping `__worker`)
- Test: `tests/cli.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces the command contract from the spec. Exit codes: 0 on success or a launched background job; 1 on any failure, nesting refusal, usage error, or a job that failed. `--json` prints one JSON document on stdout for every command.

- [ ] **Step 1: Write the failing tests**

`tests/cli.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cli.test.mjs`
Expected: FAIL — `Unknown command "setup"` and friends.

- [ ] **Step 3: Replace `claude-companion.mjs` with the full CLI**

```js
#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeArgv, parseArgs } from "./lib/args.mjs";
import { buildClaudeArgs, getClaudeAuthStatus, getClaudeAvailability } from "./lib/claude.mjs";
import { detectNesting } from "./lib/env.mjs";
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
const USAGE = [
  "Usage: node claude-companion.mjs <command> [options]",
  "  setup [--json]",
  "  task [--write|--full] [--allow <rule>]... [--resume|--fresh] [--model <m>] [--effort <low|medium|high|xhigh|max>]",
  "       [--max-turns <n>] [--max-budget-usd <x>] [--add-dir <dir>]... [--timeout-ms <n>] [--background] [--allow-nested] [--json] [--] <prompt|->",
  "  review [--adversarial] [--base <ref>] [--scope auto|working-tree|branch] [--timeout-ms <n>] [--background] [--allow-nested] [--json] [focus...]",
  "  status [job-id] [--all] [--json]",
  "  result [job-id] [--json]",
  "  cancel [job-id] [--json]",
  "  resume-candidate [--json]"
].join("\n");

const PARSE_CONFIG = {
  valueOptions: ["cwd", "model", "effort", "max-turns", "max-budget-usd", "timeout-ms", "base", "scope"],
  booleanOptions: ["json", "write", "full", "resume", "fresh", "background", "adversarial", "all", "allow-nested"],
  repeatableOptions: ["allow", "add-dir"],
  aliasMap: { C: "cwd" }
};

class UsageError extends Error {}

function parse(argv) {
  return parseArgs(normalizeArgv(argv), PARSE_CONFIG);
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

function parseIntOption(value, name) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`--${name} must be a non-negative number.`);
  return parsed;
}

function guardNesting(env, options, asJson) {
  const nesting = detectNesting(env, { allowNested: Boolean(options["allow-nested"]) });
  if (!nesting.nested) return true;
  emitFailure(asJson, failurePayload("nested", `${nesting.reason} Pass --allow-nested to override.`));
  return false;
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

async function commandSetup(argv) {
  const { options } = parse(argv);
  const { cwd, env } = resolveContext(options);
  const node = binaryAvailable(process.execPath, ["--version"]);
  const claude = getClaudeAvailability(env);
  const auth = claude.available ? getClaudeAuthStatus(env) : { loggedIn: false, detail: "claude not found" };
  const nesting = detectNesting(env);
  const nextSteps = [];
  if (!claude.available) {
    nextSteps.push("Install Claude Code (https://docs.claude.com/en/docs/claude-code/setup), for example `npm install -g @anthropic-ai/claude-code`, then re-run setup.");
  } else if (!auth.loggedIn) {
    nextSteps.push("Run `claude auth login` in your own terminal (or export ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN), then re-run setup.");
  }
  if (nesting.nested) nextSteps.push(`Nesting guard is active: ${nesting.reason}`);
  const report = { ready: node.available && claude.available && auth.loggedIn && !nesting.nested, cwd, node, claude, auth, nesting, nextSteps };
  emit(Boolean(options.json), report, renderSetupReport(report));
  if (!report.ready) process.exitCode = 1;
}

async function commandTask(argv) {
  const { options, positionals } = parse(argv);
  const asJson = Boolean(options.json);
  const { cwd, workspaceRoot, env } = resolveContext(options);
  if (!guardNesting(env, options, asJson)) return;

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
    allow: options.allow ?? [],
    resumeSessionId,
    model: options.model ?? null,
    effort: options.effort ?? null,
    maxTurns: parseIntOption(options["max-turns"], "max-turns"),
    maxBudgetUsd: options["max-budget-usd"] ?? null,
    addDirs: options["add-dir"] ?? [],
    name: `Codex → Claude: ${excerpt(prompt, 56)}`,
    appendSystemPrompt: loadCodexContext(PLUGIN_ROOT)
  });
  const background = Boolean(options.background);
  const timeoutMs = parseIntOption(options["timeout-ms"], "timeout-ms") ?? (background ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_FOREGROUND_TIMEOUT_MS);

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
  if (!guardNesting(env, options, asJson)) return;

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
  const schema = JSON.stringify(JSON.parse(fs.readFileSync(REVIEW_SCHEMA_PATH, "utf8")));
  const claudeArgs = buildClaudeArgs({
    permission: "read",
    model: options.model ?? null,
    effort: options.effort ?? null,
    name: `Codex → Claude review: ${target.label}`,
    appendSystemPrompt: loadCodexContext(PLUGIN_ROOT),
    jsonSchema: schema
  });
  const background = Boolean(options.background);
  const timeoutMs = parseIntOption(options["timeout-ms"], "timeout-ms") ?? (background ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_FOREGROUND_TIMEOUT_MS);

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
    const job = getJob(workspaceRoot, jobId, env);
    if (!job) {
      emitFailure(Boolean(options.json), failurePayload("job", `No job named ${jobId} in this workspace.`));
      return;
    }
    emit(Boolean(options.json), { ok: true, job }, renderStatusReport({ running: job.status === "running" || job.status === "queued" ? [job] : [], latestFinished: job.status === "running" || job.status === "queued" ? null : job, recent: [] }));
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
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all files passing (manifest 3, args 9, process 6, env 7, state 7, claude 9, claude-run 6, git 5, prompts 3, jobs 6, jobs-background 2, render 6, cli 10). If `cli.test.mjs` "background" hangs, check that `spawnBackgroundWorker` closes the log fd in the parent and that the worker was spawned `detached: true`.

- [ ] **Step 5: Commit**

```bash
git add plugins/claude/scripts/claude-companion.mjs tests/cli.test.mjs
git commit -m "feat(companion): full CLI with setup, task, review, status, result, cancel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Codex skills

**Files:**
- Create: `plugins/claude/skills/claude-task/SKILL.md`, `plugins/claude/skills/claude-task/agents/openai.yaml`
- Create: `plugins/claude/skills/claude-review/SKILL.md`, `plugins/claude/skills/claude-review/agents/openai.yaml`
- Create: `plugins/claude/skills/claude-setup/SKILL.md`, `plugins/claude/skills/claude-setup/agents/openai.yaml`
- Create: `plugins/claude/skills/claude-jobs/SKILL.md`, `plugins/claude/skills/claude-jobs/agents/openai.yaml`
- Test: `tests/skills.test.mjs`

**Interfaces:**
- Consumes: the CLI contract from Task 13. Every skill resolves the companion as `<skill dir>/../../scripts/claude-companion.mjs`.

- [ ] **Step 1: Write the failing test**

`tests/skills.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const SKILLS = ["claude-task", "claude-review", "claude-setup", "claude-jobs"];

test("every skill has frontmatter, a companion reference, verbatim rule, and openai.yaml", () => {
  for (const name of SKILLS) {
    const dir = path.join(ROOT, "plugins", "claude", "skills", name);
    const skill = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---`), name);
    assert.match(skill, /\.\.\/\.\.\/scripts\/claude-companion\.mjs/, name);
    assert.match(skill, /verbatim/, name);
    const yaml = fs.readFileSync(path.join(dir, "agents", "openai.yaml"), "utf8");
    assert.match(yaml, /display_name: "/, name);
    assert.match(yaml, new RegExp(`default_prompt: ".*\\$${name}`), name);
  }
});

test("review and setup skills never escalate permissions or log in", () => {
  const review = fs.readFileSync(path.join(ROOT, "plugins/claude/skills/claude-review/SKILL.md"), "utf8");
  assert.match(review, /Never apply fixes/);
  assert.equal(review.includes("--write"), false);
  const setup = fs.readFileSync(path.join(ROOT, "plugins/claude/skills/claude-setup/SKILL.md"), "utf8");
  assert.match(setup, /never attempt to log in/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/skills.test.mjs`
Expected: FAIL — ENOENT on `SKILL.md`.

- [ ] **Step 3: Write `claude-task`**

`plugins/claude/skills/claude-task/SKILL.md`:

```markdown
---
name: claude-task
description: Delegate a coding task, investigation, debugging pass, or second opinion to Claude Code running locally through its CLI. Use when the user names Claude, asks for a second implementation or diagnosis pass, or hands work to Claude explicitly. Not for ordinary work Codex can finish itself.
---

# Claude Task

You are a forwarder. Build exactly one companion command, run it, and return its stdout verbatim.

## Command

```
node "<plugin-root>/scripts/claude-companion.mjs" task [flags] -- "<prompt>"
```

`<plugin-root>` is two directories above this SKILL.md, i.e. `<this skill's directory>/../../scripts/claude-companion.mjs`. Resolve it to an absolute path before running. Quote the prompt as one argument after `--`.

## Flag mapping

- Default is read-only: Claude can read and search but cannot edit or run commands.
- `--write` when the user wants Claude to change files.
- `--full` when the user wants Claude to also run commands or tests, or says "full access". Warn once that this skips every permission check.
- `--allow "<rule>"` (repeatable) to allow specific tools, e.g. `--allow "Bash(npm test:*)"`.
- `--resume` to continue the last Claude thread in this repository; `--fresh` to force a new one.
- `--model <name>` and `--effort <low|medium|high|xhigh|max>` only when the user asks for them; otherwise leave both unset.
- `--background` when the user asks for it, or when the task is open-ended, multi-step, or likely to take more than a few minutes. Otherwise run in the foreground.
- `--allow-nested` only when the user explicitly asks to override the loop guard.

## Before running

If the request reads like a follow-up ("continue", "keep going", "apply the top fix", "dig deeper") and the user did not say `--resume` or `--fresh`, run `node "<plugin-root>/scripts/claude-companion.mjs" resume-candidate --json` first. If `available` is `true`, add `--resume`; otherwise run fresh.

## Rules

- Set the shell command timeout to at least 1,500,000 ms (25 minutes) for foreground runs. Background runs return immediately.
- Return the command's stdout verbatim. Do not summarise, paraphrase, or add commentary before or after it.
- Do not do the task yourself, inspect files on Claude's behalf, or retry with a different prompt.
- If the output says Claude is not installed or not logged in, tell the user to run `$claude-setup` and stop.
- If the command exits non-zero, show its output and stop. Never invent an answer Claude did not give.
- For a background job, tell the user to use `$claude-jobs` to check status or fetch the result.
```

`plugins/claude/skills/claude-task/agents/openai.yaml`:

```yaml
interface:
  display_name: "Claude Task"
  short_description: "Delegate a task or investigation to Claude Code"
  default_prompt: "Use $claude-task to get Claude's take on this bug and propose a fix."
  brand_color: "#6B4FBB"

policy:
  allow_implicit_invocation: true
```

- [ ] **Step 4: Write `claude-review`**

`plugins/claude/skills/claude-review/SKILL.md`:

```markdown
---
name: claude-review
description: Ask Claude Code for a read-only, structured code review of the current git working tree or branch, optionally adversarial. Use when the user wants Claude to review, critique, or challenge local changes before shipping.
---

# Claude Review

You are a forwarder. Build exactly one companion command, run it, and return its stdout verbatim.

## Command

```
node "<plugin-root>/scripts/claude-companion.mjs" review [flags] [focus text]
```

`<plugin-root>` is two directories above this SKILL.md, i.e. `<this skill's directory>/../../scripts/claude-companion.mjs`. Resolve it to an absolute path before running.

## Flag mapping

- No flags: reviews the working tree if it is dirty, otherwise the current branch against the detected base branch.
- `--base <ref>` to compare the branch against a specific ref.
- `--scope working-tree` or `--scope branch` to force a mode.
- `--adversarial` when the user wants the change challenged, stress-tested, or "torn apart".
- `--background` for large diffs or when the user asks; otherwise foreground with a shell timeout of at least 1,500,000 ms.
- Extra words after the flags are the review focus; pass them through unchanged.

The review always runs read-only. There is no flag to let it edit anything.

## Rules

- Return the command's stdout verbatim, findings first, in the order the companion prints them.
- After presenting the findings, STOP. Never apply fixes, and do not offer to fix anything until the user chooses which findings to address.
- If the output says the directory is not a git repository or no base branch was found, show it and ask the user for a `--base <ref>`.
- If the output says Claude is not installed or not logged in, tell the user to run `$claude-setup` and stop.
```

`plugins/claude/skills/claude-review/agents/openai.yaml`:

```yaml
interface:
  display_name: "Claude Review"
  short_description: "Structured code review from Claude Code"
  default_prompt: "Use $claude-review to review my working tree before I open a PR."
  brand_color: "#6B4FBB"

policy:
  allow_implicit_invocation: true
```

- [ ] **Step 5: Write `claude-setup` and `claude-jobs`**

`plugins/claude/skills/claude-setup/SKILL.md`:

```markdown
---
name: claude-setup
description: Check whether Claude Code's CLI is installed and logged in so the other claude-* skills can run, and tell the user exactly what to do if not. Use when a claude-* skill reports a missing binary or login, or when the user asks to set up or verify Claude.
---

# Claude Setup

Run exactly one command and return its stdout verbatim:

```
node "<plugin-root>/scripts/claude-companion.mjs" setup
```

`<plugin-root>` is two directories above this SKILL.md, i.e. `<this skill's directory>/../../scripts/claude-companion.mjs`.

## Rules

- If Claude Code is missing, show the install pointer from the output and stop. Do not install it without the user asking.
- If Claude Code is installed but not logged in, tell the user to run `claude auth login` in their own terminal. Never attempt to log in, paste tokens, or set credentials yourself.
- If the output reports the nesting guard is active, explain that this Codex session was started from inside Claude Code and the plugin refuses to nest.
- When everything is ready, say so in one line.
```

`plugins/claude/skills/claude-setup/agents/openai.yaml`:

```yaml
interface:
  display_name: "Claude Setup"
  short_description: "Verify Claude Code is installed and logged in"
  default_prompt: "Use $claude-setup to check that Claude Code is ready for delegation."
  brand_color: "#6B4FBB"

policy:
  allow_implicit_invocation: true
```

`plugins/claude/skills/claude-jobs/SKILL.md`:

```markdown
---
name: claude-jobs
description: Show, fetch, or cancel background Claude Code jobs started by claude-task or claude-review in this repository. Use when the user asks about a running Claude job, wants its result, or wants to stop it.
---

# Claude Jobs

Run exactly one companion command and return its stdout verbatim.

```
node "<plugin-root>/scripts/claude-companion.mjs" status [job-id] [--all]
node "<plugin-root>/scripts/claude-companion.mjs" result [job-id]
node "<plugin-root>/scripts/claude-companion.mjs" cancel [job-id]
```

`<plugin-root>` is two directories above this SKILL.md, i.e. `<this skill's directory>/../../scripts/claude-companion.mjs`.

## Mapping

- "status", "is it done", "what's running" → `status`; add `--all` when the user wants full history.
- "result", "show me what Claude said" → `result` (latest finished job when no id is given).
- "cancel", "stop it" → `cancel` (most recent running job when no id is given).

## Rules

- Return stdout verbatim; do not summarise a result or reorder findings.
- Do not poll in a loop. Run the command once per user request.
- If the output says no job was found, show it and stop.
```

`plugins/claude/skills/claude-jobs/agents/openai.yaml`:

```yaml
interface:
  display_name: "Claude Jobs"
  short_description: "Status, results, and cancel for background Claude jobs"
  default_prompt: "Use $claude-jobs to show the status of my background Claude job."
  brand_color: "#6B4FBB"

policy:
  allow_implicit_invocation: true
```

- [ ] **Step 6: Run tests and the Codex validator**

Run: `npm test`
Expected: all passing, including `skills.test.mjs` (2).

Run: `python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/claude`
Expected: `Plugin validation passed`.

- [ ] **Step 7: Commit**

```bash
git add plugins/claude/skills tests/skills.test.mjs
git commit -m "feat(skills): claude-task, claude-review, claude-setup, claude-jobs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: README, CI, and local install

**Files:**
- Create: `README.md`
- Create: `.github/workflows/test.yml`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: user-facing docs; a green CI matrix; the plugin installed into the author's Codex from the local clone.

- [ ] **Step 1: Write `.github/workflows/test.yml`**

```yaml
name: test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: git config --global user.email ci@example.com
      - run: git config --global user.name ci
      - run: npm test
```

- [ ] **Step 2: Write `README.md`**

```markdown
# codex-claude-plugin

Use Claude Code from inside OpenAI Codex, the mirror image of the official `codex` plugin for Claude Code.

Codex gets four skills: `$claude-task` delegates a task or investigation, `$claude-review` asks for a structured code review, `$claude-jobs` manages background jobs, and `$claude-setup` checks the install. They drive the `claude` CLI you already have; nothing here talks to an API directly and no API key is needed.

## Requirements

- Node.js 20 or newer
- Codex CLI 0.145 or newer (or the Codex desktop app)
- Claude Code CLI installed and logged in: run `claude auth login` once in your own terminal. An `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the environment also works.

## Install

```bash
codex plugin marketplace add k3nmastel2/codex-claude-plugin
codex plugin add claude@codex-claude-plugin
```

From a local clone instead:

```bash
codex plugin marketplace add /path/to/codex-claude-plugin
codex plugin add claude@codex-claude-plugin
```

Start a new Codex thread, then run `$claude-setup`. It tells you if anything is missing.

## Use

| Say to Codex | What happens |
|---|---|
| `$claude-task explain how sessions are refreshed` | Claude reads the repo and answers. Read-only. |
| `$claude-task --write fix the null check in auth.ts` | Claude may edit files inside the workspace. |
| `$claude-task --full run the test suite and fix failures` | Claude may edit and run commands. Skips all permission checks. |
| `$claude-task --resume apply the top fix` | Continues the last Claude thread for this repo. |
| `$claude-task --background port the parser to TypeScript` | Returns a job id immediately. |
| `$claude-review` | Structured review of the dirty working tree, or the branch vs its base. |
| `$claude-review --adversarial --base main focus on migrations` | Adversarial review with a focus. |
| `$claude-jobs status` / `result` / `cancel` | Background job management. |

Permission levels map onto Claude Code flags: read-only uses `--permission-mode dontAsk` with edit tools disallowed, `--write` uses `--permission-mode acceptEdits`, `--full` uses `--dangerously-skip-permissions`. `--allow "<rule>"` adds `--allowedTools` entries, for example `--allow "Bash(npm test:*)"`. `--model` and `--effort` pass through unchanged.

## How it works

`plugins/claude/scripts/claude-companion.mjs` runs `claude -p --output-format json`, feeds the prompt on stdin, parses the JSON result, and prints Claude's final message followed by a one-line trailer with the session id, turn count, and cost. Reviews add `--json-schema` so findings come back structured and are printed ordered by severity.

Per-repository state (last session id, job records, logs) lives under `$CODEX_HOME/claude-companion/state/` (default `~/.codex/claude-companion/state/`). Background jobs run in a detached worker; `status`, `result`, and `cancel` read the job files.

Loop guard: Claude's own `codex` plugin can call Codex, which could call this plugin, which would call Claude again. The companion refuses to run when `CLAUDE_COMPANION_DEPTH` reaches `CLAUDE_COMPANION_MAX_DEPTH` (default 1) or when it inherits `CLAUDECODE=1`, and it appends a system prompt telling Claude not to delegate back. Pass `--allow-nested` to override.

Claude runs with your own Claude Code credentials, settings, plugins, and billing. `--full` disables every permission check; use it only in repositories you trust.

## Companion CLI

```
node plugins/claude/scripts/claude-companion.mjs setup [--json]
node plugins/claude/scripts/claude-companion.mjs task [--write|--full] [--allow <rule>]... [--resume|--fresh] [--model <m>] [--effort <e>] [--max-turns <n>] [--max-budget-usd <x>] [--add-dir <d>]... [--timeout-ms <n>] [--background] [--json] [--] <prompt|->
node plugins/claude/scripts/claude-companion.mjs review [--adversarial] [--base <ref>] [--scope auto|working-tree|branch] [--timeout-ms <n>] [--background] [--json] [focus...]
node plugins/claude/scripts/claude-companion.mjs status [job-id] [--all] [--json]
node plugins/claude/scripts/claude-companion.mjs result [job-id] [--json]
node plugins/claude/scripts/claude-companion.mjs cancel [job-id] [--json]
node plugins/claude/scripts/claude-companion.mjs resume-candidate --json
```

Environment overrides: `CLAUDE_COMPANION_CLAUDE_CMD` (command used instead of `claude`, used by the tests), `CLAUDE_COMPANION_STATE_DIR`, `CLAUDE_COMPANION_MAX_DEPTH`, `CLAUDE_COMPANION_PROMPT_VIA_ARGV=1` (pass the prompt as an argument instead of stdin).

## Windows

Everything is Node with no shell dependencies. The companion resolves `claude.exe` or unwraps the npm `claude.cmd` shim so long prompts never pass through `cmd.exe`. Background jobs are cancelled with `taskkill /T`.

## Development

```bash
npm test
```

Tests use a fake `claude` binary in `tests/fixtures/`, so they run without credentials or spend. After editing the plugin, bump the version suffix in `plugins/claude/.codex-plugin/plugin.json` (for example `0.1.0+codex.20260904T170000`) and re-run `codex plugin add claude@codex-claude-plugin` so Codex reloads it; then start a new thread.

## License

MIT
```

- [ ] **Step 3: Update `CHANGELOG.md`** to describe 0.1.0 as released today with the four skills, permission levels, background jobs, loop guard, and Windows support.

- [ ] **Step 4: Install locally and verify Codex sees it**

Run:

```bash
codex plugin marketplace add ~/GitHub/codex-claude-plugin
codex plugin add claude@codex-claude-plugin
codex plugin list | grep -i claude
```

Expected: `claude@codex-claude-plugin  installed, enabled  0.1.0  …/plugins/claude`.

Then, in a throwaway directory, confirm the skills load and the forwarder runs (this spends a small amount of Codex usage):

```bash
codex exec --skip-git-repo-check --sandbox read-only -C "$(mktemp -d)" 'Use $claude-setup and report the result verbatim.'
```

Expected: Codex runs the companion `setup` command and prints its report. Until the user has run `claude auth login`, the report says `Ready: no` with the login step; that is the correct behaviour at this point.

- [ ] **Step 5: Run the full suite one more time and commit**

Run: `npm test`
Expected: all passing.

```bash
git add README.md CHANGELOG.md .github/workflows/test.yml
git commit -m "docs: README, changelog, and CI matrix

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: Publish to GitHub and run acceptance

**Files:**
- No new files. Pushes the repository and verifies CI.

- [ ] **Step 1: Create the public repository and push**

```bash
gh repo create k3nmastel2/codex-claude-plugin --public --source . --description "Use Claude Code from inside OpenAI Codex, via the claude CLI" --push
```

Expected: `https://github.com/k3nmastel2/codex-claude-plugin` exists with `main` pushed.

- [ ] **Step 2: Watch CI**

```bash
gh run watch --exit-status
```

Expected: the six-job matrix is green. If Windows fails, read the log for the failing test and fix it in a follow-up commit; the most likely culprits are path realpath casing (use `realpath()` from the helpers on both sides of the assertion) and process termination (confirm `taskkill` runs).

- [ ] **Step 3: Verify the public install path works from a clean marketplace name**

```bash
codex plugin marketplace remove codex-claude-plugin
codex plugin marketplace add k3nmastel2/codex-claude-plugin
codex plugin add claude@codex-claude-plugin
codex plugin list | grep -i claude
```

Expected: installed and enabled, sourced from the Git marketplace snapshot. Re-add the local path afterwards if you want to keep developing from the clone:

```bash
codex plugin marketplace remove codex-claude-plugin
codex plugin marketplace add ~/GitHub/codex-claude-plugin
codex plugin add claude@codex-claude-plugin
```

- [ ] **Step 4: Acceptance after the user runs `claude auth login`**

The user runs this in their own terminal (the agent must not):

```bash
claude auth login
```

Then, from any git repository with a small uncommitted change:

1. `node ~/GitHub/codex-claude-plugin/plugins/claude/scripts/claude-companion.mjs setup` → `Ready: yes`.
2. `node … task "Reply with exactly the single word: pong"` → `pong` plus a trailer with a real session id. This also proves stdin prompt delivery; if Claude answers as though the prompt were empty, set `CLAUDE_COMPANION_PROMPT_VIA_ARGV=1`, confirm it works, make argv the default in `runClaude`, update the README and CHANGELOG, and re-run the suite.
3. `node … task --resume "What was my previous message?"` → Claude recalls "pong".
4. `node … review` → a `# Claude Review (working tree)` block with structured findings or `No findings.`
5. `node … task --background "Summarise this repository's README in three bullets"` → job id; `status` shows running then succeeded; `result` prints the bullets.
6. From inside a Claude Code session, run `codex exec 'Use $claude-task to say hi'` → the companion refuses with the nesting message.
7. In a Codex thread: `$claude-task explain the top-level layout of this repo` → verbatim Claude answer with trailer.

Record the outcome of each step in `CHANGELOG.md` under 0.1.0 as "verified on macOS <date>", commit, and push.
