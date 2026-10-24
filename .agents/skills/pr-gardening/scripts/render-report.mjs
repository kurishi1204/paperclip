#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs, readJson } from "./lib.mjs";

const LABELS = { high: "High", medium: "Medium", low: "Low" };

function escapeMarkdownText(value) {
  return String(value).replace(/([\\`*_[\]()!|<>])/g, "\\$1");
}

function issueLabel(issue) {
  if (!issue) return "No originating issue";
  return issue.identifier ? `${issue.identifier} (${issue.status})` : `${issue.issueId} (${issue.status})`;
}

function reasonText(entry) {
  if (entry.reasons.length === 0) return "All mechanical readiness gates passed.";
  return entry.reasons.map((entryReason) => entryReason.message).join("; ");
}

function scopeText(readiness) {
  const authors = readiness.authors?.length
    ? `PRs authored by ${readiness.authors.map((author) => `\`${author}\``).join(", ")} (this Paperclip instance)`
    : "PRs by any author (community included)";
  const window = readiness.windowDays ? ` referenced by issues active in the last ${readiness.windowDays} day(s)` : "";
  return `${authors}${window}`;
}

export function renderReport(readiness) {
  const lines = [
    "# PR Gardening Report",
    "",
    `Repository: \`${readiness.repository}\`  `,
    `Scope: ${scopeText(readiness)}  `,
    `Generated: ${readiness.generatedAt}  `,
    readiness.schemaVersion === 2 ? "Head-SHA evidence is recorded per entry. Unknown or changed evidence blocks readiness." : `Head-SHA verification: every verdict below was computed from the recorded current head SHA.`,
    "",
    `Summary: **${readiness.summary.ready} ready**, **${readiness.summary.needsGardening} need gardening**, **${readiness.summary.reportOnly} report-only drafts**.`,
    "",
  ];

  if (readiness.truncatedIssues?.length) {
    lines.push(
      `Discovery caveat: ${readiness.truncatedIssues.length} issue(s) hit the per-issue extract match cap, so PR mentions beyond the cap were not scanned: ${readiness.truncatedIssues.map((issue) => issue.identifier ?? issue.issueId).join(", ")}.`,
      "",
    );
  }

  for (const confidence of ["high", "medium", "low"]) {
    const entries = readiness.pullRequests.filter((entry) => entry.confidence === confidence && (entry.state === "open" || entry.policy === "fork-v1"));
    lines.push(`## ${LABELS[confidence]} Confidence`, "");
    if (entries.length === 0) {
      lines.push("_None._", "");
      continue;
    }
    for (const entry of entries) {
      const draft = entry.isDraft ? " — draft (report only)" : "";
      if (entry.policy === "fork-v1") {
        const checks = entry.checks?.checks ?? [];
        const review = entry.independentReview ?? { status: "unreceived" };
        const findings = entry.findings ?? { complete: false, missing: ["enumeration unreceived"], orphaned: [] };
        const count = (predicate) => checks.filter(predicate).length;
        lines.push(
          `### [#${entry.number}](${entry.url ?? `https://github.com/${readiness.repository}/pull/${entry.number}`}) — ${escapeMarkdownText(entry.title)}${draft}`,
          "",
          `- Verdict: \`${entry.verdict}\` (advisory; no adoption or deployment)`,
          `- State: \`${escapeMarkdownText(entry.state ?? "unknown")}\``,
          `- Head: \`${entry.headSha ?? "unreceived"}\``,
          `- CI inventory: ${checks.length}; successful ${count(c=>c.green)}, pending ${count(c=>c.pending)}, skipped ${count(c=>c.conclusion==="skipped")}, neutral ${count(c=>c.conclusion==="neutral")}, other unsuccessful ${count(c=>!c.green&&!c.pending&&!["skipped","neutral"].includes(c.conclusion))}`,
          `- Normal PR CI: Run ${entry.normalCI?.runID ?? "unreceived"}; successful jobs ${entry.normalCI?.jobs ?? "unreceived"}`,
          `- Independent review: ${escapeMarkdownText(review.status)}; model ${escapeMarkdownText(review.model ?? "unreceived")}; reviewed head ${escapeMarkdownText(review.headSha ?? "unreceived")}; report digest ${escapeMarkdownText(review.reportSHA256 ?? "unreceived")}`,
          `- Review binding: tree ${escapeMarkdownText(review.treeSha ?? "unreceived")}; session ${escapeMarkdownText(review.sessionID ?? "unreceived")}; input ${escapeMarkdownText(review.inputSHA256 ?? "unreceived")}`,
          `- Findings: ${findings.complete ? "current dispositions complete" : "incomplete"}; unprocessed ${escapeMarkdownText(findings.missing.join(", ") || "none")}; orphaned ${escapeMarkdownText(findings.orphaned.join(", ") || "none")}`,
          `- Greptile (additional evidence): ${escapeMarkdownText(entry.greptile?.state ?? "unreceived")}; score unreceived unless separately reported by the provider`,
          `- Reasons: ${escapeMarkdownText(reasonText(entry))}`,
          "",
        );
        continue;
      }

      lines.push(
        `### [#${entry.number}](${entry.url}) — ${escapeMarkdownText(entry.title)}${draft}`,
        "",
        `- Purpose: ${escapeMarkdownText(entry.purpose ?? "No description provided.")}`,
        `- Author: ${entry.author ? `\`${entry.author}\`` : "unknown"}`,
        `- Verdict: \`${entry.verdict}\``,
        `- Head: \`${entry.headSha}\``,
        `- Originating issue: ${issueLabel(entry.originatingIssue)}`,
        `- Checks: ${entry.checks.checks.length - entry.checks.pending.length - entry.checks.failing.length} green, ${entry.checks.pending.length} pending, ${entry.checks.failing.length} failing`,
        `- Greptile: ${entry.greptile.clean ? "clean" : entry.greptile.present ? "not clean/current" : "missing"}`,
        `- Base distance: ${entry.behindBy} commit(s) behind \`${entry.baseRefName}\``,
        `- Reasons: ${reasonText(entry)}`,
        "",
      );
    }
  }

  lines.push(
    "## Guardrail",
    "",
    "This report is advisory. The gardening workflow never merges, approves, or closes pull requests and never instructs anyone to merge them.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2), { input: "readiness.json", output: "gardening-report.md" });
  const report = renderReport(readJson(options.input));
  if (options.output === "-") process.stdout.write(report);
  else writeFileSync(options.output, report);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
