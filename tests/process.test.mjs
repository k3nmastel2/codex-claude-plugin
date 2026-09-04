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
