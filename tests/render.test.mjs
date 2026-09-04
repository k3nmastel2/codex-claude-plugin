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
  assert.match(text, /## Next steps\n- Add a null guard\n\nclaude session sess-1 · 3 turns · \$0\.0457\n$/, "review trailer has no resume hint");
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
