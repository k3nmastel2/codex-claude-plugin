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
