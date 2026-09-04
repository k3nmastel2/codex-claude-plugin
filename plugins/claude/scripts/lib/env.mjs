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

export const SANDBOX_ENV = "CODEX_SANDBOX";
export const SANDBOX_NETWORK_ENV = "CODEX_SANDBOX_NETWORK_DISABLED";

// Codex marks commands it runs inside its sandbox. With network disabled, Claude cannot
// reach its API and, on macOS, cannot read the login keychain either.
export function detectSandbox(env) {
  const sandbox = String(env[SANDBOX_ENV] ?? "").trim();
  const networkDisabled = String(env[SANDBOX_NETWORK_ENV] ?? "") === "1";
  if (!sandbox && !networkDisabled) {
    return { sandboxed: false, networkDisabled: false, reason: null };
  }
  const label = sandbox ? `Codex's ${sandbox} sandbox` : "Codex's sandbox";
  const reason = networkDisabled
    ? `This command is running inside ${label} with network access disabled (${SANDBOX_NETWORK_ENV}=1), so Claude cannot reach its API or your login. Ask Codex to re-run it with escalated permissions, outside the sandbox, or set network_access = true under [sandbox_workspace_write] in ~/.codex/config.toml.`
    : `This command is running inside ${label}. If Claude reports it is not logged in, re-run it with escalated permissions.`;
  return { sandboxed: true, networkDisabled, reason };
}
