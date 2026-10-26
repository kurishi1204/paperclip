import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueExecutionDecisions, issues } from "@paperclipai/db";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A native finish can preserve only the formal verdict this run reserved and actually committed. */
export async function readFormalIssueApprovalDecision(input: {
  db: Db;
  issue: typeof issues.$inferSelect;
  runId: string;
  agentId: string;
}) {
  const [run] = await input.db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.issue.companyId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.nativeIssueId, input.issue.id),
  )).limit(1);
  if (!run) return null;
  const decisions = await input.db.select().from(issueExecutionDecisions).where(and(
    eq(issueExecutionDecisions.companyId, input.issue.companyId),
    eq(issueExecutionDecisions.issueId, input.issue.id),
    eq(issueExecutionDecisions.stageType, "approval"),
    eq(issueExecutionDecisions.actorAgentId, input.agentId),
    eq(issueExecutionDecisions.createdByRunId, input.runId),
  )).orderBy(desc(issueExecutionDecisions.createdAt), desc(issueExecutionDecisions.id));
  const attempts = object(object(run.resultJson).approvalStageAttempts);
  for (const decision of decisions) {
    const attempt = object(attempts[decision.stageId]);
    const reservedInput = object(attempt.input);
    const digest = createHash("sha256").update(canonicalJson(reservedInput)).digest("hex");
    if (attempt.digest !== digest || reservedInput.expectedStageId !== decision.stageId ||
        reservedInput.summary !== decision.body ||
        reservedInput.decision !== (decision.outcome === "approved" ? "approve" : "request_changes") ||
        (attempt.decisionId !== undefined && attempt.decisionId !== decision.id)) continue;
    return decision;
  }
  return null;
}
