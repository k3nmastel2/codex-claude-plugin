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
