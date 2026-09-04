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
