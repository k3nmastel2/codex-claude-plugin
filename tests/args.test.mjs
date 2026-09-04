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
