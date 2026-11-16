import { and, eq, gte, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { issueExecutionPolicySchema } from "@paperclipai/shared";
import {
  agentWakeupRequests, heartbeatRuns, issues, issueThreadInteractions,
  nativeRunFinalizations, statusDecisionEffects, type Db,
} from "@paperclipai/db";
import { conflict, notFound } from "../../errors.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { nativeSha256 } from "./canonical.js";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext } from "./native-review-participant.js";
import { enqueueNativeStatusWakeIntent } from "./status-wake-intent.js";

// A precondition, never a caller-supplied reviewer or privileged wake context.
export const requestNativeReviewReturnSchema = z.object({
  expectedIssueRevision: z.number().int().nonnegative(),
  expectedDecisionId: z.string().uuid(),
  previousReviewerRunId: z.string().uuid(),
}).strict();

export async function requestNativeReviewReturn(db: Db, input: {
  companyId: string; issueId: string; interactionId: string; userId: string;
  expected: z.infer<typeof requestNativeReviewReturnSchema>;
  authorizeReviewer: (agentId: string) => Promise<void>;
}) {
  const result = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const issue = await tx.select().from(issues).where(and(
      eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
    )).for("update").limit(1).then(rows => rows[0]);
    if (!issue) throw notFound("Issue not found");
    const card = await tx.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, issue.id), eq(issueThreadInteractions.id, input.interactionId),
    )).for("update").limit(1).then(rows => rows[0]);
    if (!card?.addresseeAgentId) throw conflict("Original reviewer is unavailable");
    await input.authorizeReviewer(card.addresseeAgentId);
    if (issue.revision !== input.expected.expectedIssueRevision || issue.executionRunId || issue.checkoutRunId)
      throw conflict("Issue changed or has an execution owner");
    if (card.status !== "pending") throw conflict("Review is no longer pending");
    const policy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
    if (!policy.success || !policy.data.stages.some(stage =>
      stage.participants.some(participant => participant.agentId === card.addresseeAgentId)))
      throw conflict("Reviewer is no longer designated by the current policy");
    const context = {
      nativeReviewInteractionId: card.id,
      nativeReviewDecisionId: input.expected.expectedDecisionId,
    };
    const assignment = await getNativeReviewAssignment(tx, {
      companyId: issue.companyId, issueId: issue.id, agentId: card.addresseeAgentId,
      contextSnapshot: context,
    });
    if (!assignment) throw conflict("Original review assignment changed");

    // One return per original card, including failed/skipped/unknown attempts.
    // The issue row serializes concurrent callers; no delivered effect is reset.
    const key = `native-review-return:${card.id}`;
    const priorReturn = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.idempotencyKey, key),
    )).limit(1).then(rows => rows[0]);
    if (priorReturn) throw conflict("Reviewer return already recorded; inspect its receipt", {
      wakeupRequestId: priorReturn.id, status: priorReturn.status, runId: priorReturn.runId,
      automaticRetry: false,
    });

    const previous = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.expected.previousReviewerRunId), eq(heartbeatRuns.companyId, issue.companyId),
      eq(heartbeatRuns.nativeIssueId, issue.id), eq(heartbeatRuns.agentId, card.addresseeAgentId),
    )).limit(1).then(rows => rows[0]);
    const previousContext = readNativeReviewAssignmentContext(previous?.contextSnapshot);
    if (!previous || previous.runtimeMode !== "native" || previous.status !== "succeeded"
      || previous.exitCode !== 0 || previous.signal || !previous.finishedAt || !previous.startedAt
      || !previous.wakeupRequestId || nativeSha256(previousContext) !== nativeSha256(context))
      throw conflict("Previous reviewer execution is not positively completed");
    const storedContext = previous.contextSnapshot ?? {};
    if ((storedContext.issueId !== undefined && storedContext.issueId !== issue.id)
      || (storedContext.sourceRunId !== undefined && storedContext.sourceRunId !== assignment.sourceRun.id)
      || (storedContext.revisionId !== undefined && storedContext.revisionId !== context.nativeReviewDecisionId))
      throw conflict("Previous reviewer context conflicts with the original assignment");
    const finalization = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, issue.companyId), eq(nativeRunFinalizations.issueId, issue.id),
      eq(nativeRunFinalizations.runId, previous.id),
    )).limit(1).then(rows => rows[0]);
    if (finalization?.phase !== "committed" || finalization.failureCode
      || finalization.leaseOwner || finalization.recoveryState)
      throw conflict("Previous reviewer finalization is not settled");

    const effects = await tx.select().from(statusDecisionEffects).where(and(
      eq(statusDecisionEffects.companyId, issue.companyId), eq(statusDecisionEffects.issueId, issue.id),
      eq(statusDecisionEffects.decisionId, context.nativeReviewDecisionId),
      eq(statusDecisionEffects.effectKind, "bind_reviewer"), eq(statusDecisionEffects.targetId, card.id),
    ));
    const matching = effects.filter(effect => effect.payload.interactionId === card.id);
    if (matching.length !== 1 || matching[0].payload.ownerAgentId !== card.addresseeAgentId
      || matching[0].deliveryState !== "delivered" || !matching[0].deliveredAt
      || typeof matching[0].payload.reviewerWakeId !== "string")
      throw conflict("Original review delivery is not proved");
    const originalIntent = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId),
      eq(agentWakeupRequests.id, matching[0].payload.reviewerWakeId as string),
      eq(agentWakeupRequests.agentId, card.addresseeAgentId),
    )).limit(1).then(rows => rows[0]);
    const previousWake = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.id, previous.wakeupRequestId),
      eq(agentWakeupRequests.agentId, card.addresseeAgentId),
    )).limit(1).then(rows => rows[0]);
    if (!originalIntent || !["completed", "coalesced"].includes(originalIntent.status)
      || originalIntent.reason !== "native_completion_review"
      || originalIntent.idempotencyKey !== `native-review:${card.id}`
      || originalIntent.requestedByActorType !== "system" || originalIntent.requestedByActorId !== "native-status-committer"
      || originalIntent.runId !== previous.id || !previousWake || previousWake.status !== "completed"
      || previousWake.runId !== previous.id)
      throw conflict("Original delivery and completed run receipts do not match");

    const successor = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.nativeIssueId, issue.id),
      ne(heartbeatRuns.id, previous.id),
      or(and(eq(heartbeatRuns.agentId, card.addresseeAgentId), gte(heartbeatRuns.createdAt, previous.createdAt)),
        inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])),
    )).limit(1).then(rows => rows[0]);
    const pendingWake = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId),
      sql`coalesce(${agentWakeupRequests.payload}->>'issueId', ${agentWakeupRequests.payload}->>'taskId', ${agentWakeupRequests.payload}#>>'{_paperclipWakeContext,issueId}') = ${issue.id}`,
      notInArray(agentWakeupRequests.status, ["completed", "coalesced"]),
    )).limit(1).then(rows => rows[0]);
    if (successor || pendingWake) throw conflict("A later execution or unresolved delivery must be received first");

    const wakeupRequestId = await enqueueNativeStatusWakeIntent({
      tx, companyId: issue.companyId, issueId: issue.id, agentId: card.addresseeAgentId,
      reason: "native_completion_review", idempotencyKey: key,
      payload: { ...context, previousReviewerRunId: previous.id, requestedByUserId: input.userId },
      contextSnapshot: {
        ...context, forceFreshSession: true,
        nativeReviewReturn: { previousRunId: previous.id, policySha256: nativeSha256(issue.executionPolicy),
          interactionPayloadSha256: nativeSha256(card.payload) },
      },
    });
    const audit = await persistActivity(tx, {
      companyId: issue.companyId, actorType: "user", actorId: input.userId,
      action: "issue.native_review_return_requested", entityType: "issue", entityId: issue.id,
      details: { ...context, previousReviewerRunId: previous.id, wakeupRequestId, reviewerAgentId: card.addresseeAgentId },
    });
    return { receipt: { wakeupRequestId, interactionId: card.id, reviewerAgentId: card.addresseeAgentId,
      previousReviewerRunId: previous.id, status: "queued" as const, automaticRetry: false }, publication: audit.publication };
  });
  publishActivity(result.publication);
  return result.receipt;
}
