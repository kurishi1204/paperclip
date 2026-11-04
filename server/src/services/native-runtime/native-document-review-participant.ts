import { parseObject } from "../../adapters/utils.js";
import { and, eq, inArray } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { hasPendingDocumentReviewAdmission, readCurrentPendingDocumentReviewWake } from "../pending-document-review-wake.js";

/** A document-review run owns its saved request, never task assignment. */
export async function getNativeDocumentReviewAssignment(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string;
  allowResolved?: boolean; lock?: boolean;
}) {
  const query = db.select({ run: heartbeatRuns, issue: issues, agent: agents })
    .from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .innerJoin(agents, and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId))).limit(1);
  const [row] = await (input.lock ? query.for("share", {of:[heartbeatRuns,issues,agents]}) : query);
  if (!row || !hasPendingDocumentReviewAdmission(row.run.runnerProfileJson) ||
      row.run.runtimeMode !== "native" || row.run.nativeIssueId !== input.issueId ||
      !["queued", "running"].includes(row.run.status) ||
      ["paused", "terminated", "pending_approval", "error"].includes(row.agent.status)) return null;
  const review = await readCurrentPendingDocumentReviewWake(db, {
    ...input, contextSnapshot: row.run.contextSnapshot ?? {}, lock:input.lock,
    ...(input.allowResolved ? { allowResolvedByRunId: input.runId } : {}),
  });
  if (!review) return null;
  const admission = parseObject(parseObject(row.run.runnerProfileJson).pendingDocumentReviewAdmission);
  if (typeof admission.nonAssignee !== "boolean" ||
      (review.interaction.status === "pending" && admission.nonAssignee !== (row.issue.assigneeAgentId !== input.agentId)) ||
      (review.interaction.status === "pending" && row.issue.executionRunId !== input.runId)) return null;
  return review;
}

/** Classify purpose separately from admission validity. Losing the saved role
 * never converts a document reviewer into a worker. Original accepted receipts
 * identify the purpose even if the serialized profile/context was removed.
 * This grants no access: every review use still requires current admission. */
export async function isNativeDocumentReviewRun(db: Db, input: {
  companyId: string; agentId: string; runId: string;
  runnerProfileJson?: unknown; contextSnapshot?: unknown; retryOfRunId?: string | null;
}): Promise<boolean> {
  let cursor = input;
  const visited = new Set<string>();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (;;) {
    if (visited.has(cursor.runId)) throw new Error("native_run_receipt_ancestry_cycle");
    visited.add(cursor.runId);
    if (hasPendingDocumentReviewAdmission(cursor.runnerProfileJson)) return true;
    const candidates = new Set<string>();
    const add = (value: unknown) => { if (typeof value === "string" && uuid.test(value)) candidates.add(value); };
    add(parseObject(cursor.contextSnapshot).interactionId);
    const receipts = await db.select({payload: agentWakeupRequests.payload,idempotencyKey:agentWakeupRequests.idempotencyKey}).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId), eq(agentWakeupRequests.runId, cursor.runId)));
    for (const receipt of receipts) add(parseObject(receipt.payload).interactionId);
    if (candidates.size) {
      const cards = await db.select({id:issueThreadInteractions.id,kind:issueThreadInteractions.kind,payload:issueThreadInteractions.payload,
        addresseeAgentId:issueThreadInteractions.addresseeAgentId,status:issueThreadInteractions.status,resolvedByRunId:issueThreadInteractions.resolvedByRunId})
        .from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId,input.companyId),
          inArray(issueThreadInteractions.id,[...candidates])));
      if (cards.some(card => card.kind === "request_confirmation" &&
          parseObject(parseObject(card.payload).target).type === "issue_document" && (
            receipts.some(receipt => receipt.idempotencyKey === `interaction-pending:${card.id}` &&
              parseObject(receipt.payload).interactionId === card.id) ||
            (card.addresseeAgentId === input.agentId &&
              (card.status === "pending" || card.resolvedByRunId === cursor.runId))
          ))) return true;
    }
    if (!cursor.retryOfRunId) return false;
    const [parent] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id,cursor.retryOfRunId),eq(heartbeatRuns.companyId,input.companyId),
      eq(heartbeatRuns.agentId,input.agentId))).limit(1);
    if (!parent) return false;
    cursor = {...parent,runId:parent.id};
  }
}
