import { parseObject } from "../../adapters/utils.js";
import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { hasPendingDocumentReviewAdmission, readCurrentPendingDocumentReviewWake } from "../pending-document-review-wake.js";

/** A document-review run owns its saved request, never task assignment. */
export async function getNativeDocumentReviewAssignment(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string;
  allowResolved?: boolean;
}) {
  const [row] = await db.select({ run: heartbeatRuns, issue: issues, agent: agents })
    .from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .innerJoin(agents, and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId))).limit(1);
  if (!row || !hasPendingDocumentReviewAdmission(row.run.runnerProfileJson) ||
      row.run.runtimeMode !== "native" || row.run.nativeIssueId !== input.issueId ||
      !["queued", "running"].includes(row.run.status) ||
      ["paused", "terminated", "pending_approval", "error"].includes(row.agent.status)) return null;
  const review = await readCurrentPendingDocumentReviewWake(db, {
    ...input, contextSnapshot: row.run.contextSnapshot ?? {},
    ...(input.allowResolved ? { allowResolvedByRunId: input.runId } : {}),
  });
  if (!review) return null;
  const admission = parseObject(parseObject(row.run.runnerProfileJson).pendingDocumentReviewAdmission);
  if (typeof admission.nonAssignee !== "boolean" ||
      (review.interaction.status === "pending" && admission.nonAssignee !== (row.issue.assigneeAgentId !== input.agentId)) ||
      (review.interaction.status === "pending" && row.issue.executionRunId !== input.runId)) return null;
  return review;
}
