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
    `- nesting: ${report.nesting.nested ? `blocked — ${report.nesting.reason}` : "clear"}`,
    `- sandbox: ${report.sandbox?.networkDisabled ? "Codex sandbox with network disabled" : report.sandbox?.sandboxed ? "Codex sandbox (network allowed)" : "none detected"}`
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
