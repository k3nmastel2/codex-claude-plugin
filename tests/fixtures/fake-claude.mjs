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
