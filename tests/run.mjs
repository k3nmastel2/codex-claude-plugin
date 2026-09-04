#!/usr/bin/env node
// Runs every *.test.mjs in this directory with node --test.
// A plain file list works on every supported Node version and OS: Node 20 does not
// expand glob patterns in --test, and Node 22 rejects a bare directory argument.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(here, name));

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
