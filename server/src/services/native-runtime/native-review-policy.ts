import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { issueExecutionPolicySchema } from "@paperclipai/shared";
import { activityLog, agents, agentWakeupRequests, companyMemberships, heartbeatRuns,
  issues, issueThreadInteractions, nativeRunFinalizations, statusDecisions,
  statusDecisionEffects, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../../errors.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { canonicalizeStoredResolverPolicy } from "../issue-thread-interaction-resolution.js";
import { nativeSha256 } from "./canonical.js";
import { readNativeCompletionDocumentRevisions, assertNativeCompletionDocumentAuthorsIndependent } from "./native-completion-document-binding.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const expected = {
  expectedIssueRevision: z.number().int().nonnegative(),
  expectedStatusVersion: z.number().int().nonnegative(),
  expectedDecisionId: z.string().uuid(),
  expectedPolicySha256: sha,
  expectedCardsSha256: sha,
  expectedDocumentsSha256: sha,
};
export const nativeReviewPolicySchema = z.discriminatedUnion("operation", [
  z.object({ ...expected, operation: z.literal("amend"), replacementAgentId: z.string().uuid(),
    oldApprovalDisposition: z.literal("withdraw_for_author_resubmission") }).strict(),
  z.object({ ...expected, operation: z.literal("restore"), amendmentActivityId: z.string().uuid() }).strict(),
]);

// Original payloads and delivery records remain intact. Explicit administrative
// withdrawal is not a verdict, replacement, wake or replay. Only the author's next submission binds the
// replacement approver to new documents and a new completion decision.
export async function amendNativeReviewPolicy(db: Db, input: {
  companyId: string; issueId: string; userId: string;
  expected: z.infer<typeof nativeReviewPolicySchema>;
}) {
  const result = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const issue = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId),
      eq(issues.id, input.issueId))).for("update").limit(1).then(rows => rows[0]);
    if (!issue) throw notFound("Issue not found");
    // Lock the actual membership; an admin/local-implicit actor is not a substitute.
    const owner = await tx.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, issue.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, input.userId))).for("share").limit(1).then(rows => rows[0]);
    if (owner?.status !== "active" || owner.membershipRole !== "owner")
      throw forbidden("Review policy amendment requires the active company owner");
    const e = input.expected;
    if (issue.revision !== e.expectedIssueRevision || issue.statusVersion !== e.expectedStatusVersion
      || issue.lastStatusDecisionId !== e.expectedDecisionId || issue.status !== "in_review"
      || issue.executionRunId || issue.checkoutRunId || issue.executionState || issue.reviewPolicy)
      throw conflict("Review policy state changed or is executing");
    const parsed = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
    if (!parsed.success || nativeSha256(issue.executionPolicy) !== e.expectedPolicySha256)
      throw conflict("Review policy pin changed");
    const policy = parsed.data;
    // This entry substitutes one independent approval role, never the QA stage,
    // quorum, mode, monitor, assignee, status or run ownership.
    if (policy.mode !== "normal" || policy.monitor || policy.stages.length !== 2
      || policy.stages[0].type !== "review" || policy.stages[1].type !== "approval"
      || policy.stages.some(s => s.approvalsNeeded !== 1 || s.participants.length !== 1
        || s.participants[0].type !== "agent" || !s.participants[0].agentId || s.participants[0].userId))
      throw conflict("Only one QA and one independent approval role are supported");
    const decision = await tx.select().from(statusDecisions).where(and(
      eq(statusDecisions.companyId, issue.companyId), eq(statusDecisions.issueId, issue.id),
      eq(statusDecisions.id, e.expectedDecisionId))).limit(1).then(rows => rows[0]);
    if (!decision || decision.applicationState !== "applied"
      || decision.decisionJson.projectedStatusVersion !== issue.statusVersion)
      throw conflict("Original completion decision changed");
    const cards = await tx.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id),
      or(eq(issueThreadInteractions.status, "pending"),
        sql`${issueThreadInteractions.payload}->'target'->>'revisionId' = ${decision.id}`))).orderBy(issueThreadInteractions.id).for("update");
    const cardPin = nativeSha256(JSON.parse(JSON.stringify(cards)));
    if (cardPin !== e.expectedCardsSha256 || cards.length !== 2
      || cards.some(c => c.kind !== "request_confirmation" || c.sourceRunId !== decision.runId
        || c.createdByAgentId || c.createdByUserId || !c.addresseeAgentId || c.addresseeUserId
        || canonicalizeStoredResolverPolicy(c.effectiveResolverPolicy, c.resolverPolicyProvenance) === "human_only"
        || (c.payload as unknown as Record<string, unknown>).toolAction || (c.payload as unknown as Record<string, unknown>).secretProposal
        || ((c.payload as unknown as Record<string, unknown>).target as Record<string, unknown>)?.key !== "native_completion_review"
        || ((c.payload as unknown as Record<string, unknown>).target as Record<string, unknown>)?.type !== "custom"
        || ((c.payload as unknown as Record<string, unknown>).target as Record<string, unknown>)?.revisionId !== decision.id))
      throw conflict("Pending review cards changed or are inconsistent");
    const effects = await tx.select().from(statusDecisionEffects).where(and(
      eq(statusDecisionEffects.companyId, issue.companyId), eq(statusDecisionEffects.issueId, issue.id),
      eq(statusDecisionEffects.decisionId, decision.id), eq(statusDecisionEffects.effectKind, "bind_reviewer")));
    if (effects.length !== cards.length || cards.some(card => effects.filter(effect =>
      effect.targetType === "issue_thread_interaction" && effect.targetId === card.id
      && effect.payload.interactionId === card.id && effect.payload.ownerAgentId === card.addresseeAgentId
      && effect.deliveryState === "delivered" && effect.deliveredAt).length !== 1))
      throw conflict("Original card delivery is unresolved");
    const documents = await readNativeCompletionDocumentRevisions(tx, { companyId: issue.companyId, issueId: issue.id, requireComplete: true });
    if (nativeSha256(documents) !== e.expectedDocumentsSha256)
      throw conflict("Submitted document set changed");

    let replacement: string;
    let nextPolicy: typeof issue.executionPolicy;
    let restoredActivityId: string | null = null;
    let restoreExecutionBoundary: unknown;
    if (e.operation === "amend") {
      const designated = policy.stages.map(s => s.participants[0].agentId!);
      if (cards.some(c => c.status !== "pending") || new Set(cards.map(c => c.addresseeAgentId)).size !== 2
        || cards.some(c => !designated.includes(c.addresseeAgentId!)))
        throw conflict("Original participants and cards disagree");
      replacement = e.replacementAgentId;
      if (designated.includes(replacement) || replacement === issue.assigneeAgentId)
        throw conflict("Replacement must be independent of the author and QA");
      await assertNativeCompletionDocumentAuthorsIndependent(tx, issue.companyId, documents, replacement);
      const exactPolicy = structuredClone(issue.executionPolicy!) as z.infer<typeof issueExecutionPolicySchema>;
      exactPolicy.stages[1].participants[0].agentId = replacement;
      nextPolicy = exactPolicy;
    } else {
      const original = await tx.select().from(activityLog).where(and(eq(activityLog.id, e.amendmentActivityId),
        eq(activityLog.companyId, issue.companyId), eq(activityLog.entityId, issue.id),
        eq(activityLog.action, "issue.native_review_policy_amended"))).limit(1).then(rows => rows[0]);
      const d = original?.details;
      if (!d || original.actorType !== "user" || original.actorId !== input.userId
        || d.postRevision !== issue.revision || d.statusVersion !== issue.statusVersion
        || d.decisionId !== decision.id || d.postCardsSha256 !== cardPin
        || d.documentsSha256 !== e.expectedDocumentsSha256
        || nativeSha256(d.afterPolicy) !== e.expectedPolicySha256)
        throw conflict("Amendment cannot be restored after intervening work");
      const before = issueExecutionPolicySchema.safeParse(d.beforePolicy);
      if (!before.success) throw conflict("Original amendment policy is unavailable");
      nextPolicy = d.beforePolicy as typeof issue.executionPolicy;
      replacement = before.data.stages[1].participants[0].agentId!;
      restoredActivityId = original.id;
      restoreExecutionBoundary = d.executionBoundarySha256;
      // Restores the prior configuration only. Original author-exclusion at
      // acceptance remains mandatory; this is never a content approval.
    }
    const candidate = await tx.select().from(agents).where(and(eq(agents.companyId, issue.companyId),
      eq(agents.id, replacement))).for("share").limit(1).then(rows => rows[0]);
    if (!candidate || !["idle", "active"].includes(candidate.status) || candidate.adapterType !== "paperclip_runner")
      throw conflict("Replacement agent is not eligible for native review");
    // No reclassification of historical UNKNOWN as stopped. This intentionally
    // requires positive completion receipts, including the candidate's other work.
    const approvalAgents = [...new Set([policy.stages[1].participants[0].agentId!, replacement])].sort();
    const runs = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, issue.companyId),
      or(eq(heartbeatRuns.nativeIssueId, issue.id), inArray(heartbeatRuns.agentId, approvalAgents))));
    const finals = runs.length ? await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, issue.companyId), inArray(nativeRunFinalizations.runId, runs.map(r => r.id)))) : [];
    if (!runs.some(run => run.id === decision.runId && run.nativeIssueId === issue.id
      && run.companyId === issue.companyId && run.agentId === issue.assigneeAgentId))
      throw conflict("Original submitting author changed");
    if (runs.some(run => run.status !== "succeeded" || run.exitCode !== 0 || run.signal || !run.finishedAt
      || (run.runtimeMode === "native" && !finals.some(f => f.runId === run.id && f.phase === "committed"
        && !f.failureCode && !f.leaseOwner && !f.recoveryState))))
      throw conflict("Execution or historical result is not positively settled");
    const executionBoundarySha256 = nativeSha256(JSON.parse(JSON.stringify({
      runs: runs.map(r => ({ id: r.id, agentId: r.agentId, status: r.status, exitCode: r.exitCode,
        signal: r.signal, finishedAt: r.finishedAt, updatedAt: r.updatedAt })).sort((a, b) => a.id.localeCompare(b.id)),
      finalizations: finals.map(f => ({ runId: f.runId, phase: f.phase, resultId: f.resultId,
        decisionId: f.decisionId, updatedAt: f.updatedAt })).sort((a, b) => a.runId.localeCompare(b.runId)),
    })));
    if (e.operation === "restore" && restoreExecutionBoundary !== executionBoundarySha256)
      throw conflict("Execution advanced after the policy amendment");
    const wake = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId),
      or(inArray(agentWakeupRequests.agentId, approvalAgents),
        sql`coalesce(${agentWakeupRequests.payload}->>'issueId', ${agentWakeupRequests.payload}->>'taskId', ${agentWakeupRequests.payload}#>>'{_paperclipWakeContext,issueId}') = ${issue.id}`),
      notInArray(agentWakeupRequests.status, ["completed", "coalesced"]))).limit(1).then(rows => rows[0]);
    if (wake) throw conflict("Unresolved delivery must be received before policy amendment");
    const [updated] = await tx.update(issues).set({ executionPolicy: nextPolicy, updatedAt: new Date() }).where(and(
      eq(issues.id, issue.id), eq(issues.companyId, issue.companyId), eq(issues.revision, e.expectedIssueRevision),
      eq(issues.statusVersion, e.expectedStatusVersion), eq(issues.lastStatusDecisionId, e.expectedDecisionId))).returning();
    if (!updated) throw conflict("Policy compare-and-swap lost");
    let postCards = cards;
    if (e.operation === "amend") {
      const oldApproval = cards.find(c => c.addresseeAgentId === policy.stages[1].participants[0].agentId)!;
      const [withdrawn] = await tx.update(issueThreadInteractions).set({
        status: "cancelled", result: { version: 1, outcome: "withdrawn",
          reason: "Approval role amended; original author resubmission required." },
        resolvedByUserId: input.userId, resolvedByAgentId: null, resolvedByRunId: null,
        resolvedAt: new Date(), updatedAt: new Date(),
      }).where(and(eq(issueThreadInteractions.id, oldApproval.id), eq(issueThreadInteractions.status, "pending"))).returning();
      if (!withdrawn) throw conflict("Old approval card changed during migration");
      postCards = cards.map(c => c.id === withdrawn.id ? withdrawn : c);
    }
    // Child updates bump the issue revision too. Return the actual final CAS
    // version, not an assumed +1. Restore never resurrects the withdrawn card.
    const finalIssue = await tx.select({ revision: issues.revision }).from(issues).where(eq(issues.id, issue.id))
      .limit(1).then(rows => rows[0]);
    if (!finalIssue) throw conflict("Policy receipt revision is unavailable");
    const postCardsSha256 = nativeSha256(JSON.parse(JSON.stringify(postCards)));
    const nextParticipants = issueExecutionPolicySchema.parse(nextPolicy).stages.flatMap(stage =>
      stage.participants.map(participant => participant.agentId));
    const retainedCards = postCards.map(card => ({ interactionId: card.id, originalAgentId: card.addresseeAgentId,
      status: card.status, disposition: card.status === "cancelled" ? "withdrawn_no_resurrection"
        : nextParticipants.includes(card.addresseeAgentId) ? "original_role_retained" : "original_role_removed_no_retarget" }));
    const audit = await persistActivity(tx, { companyId: issue.companyId, actorType: "user", actorId: input.userId,
      action: e.operation === "amend" ? "issue.native_review_policy_amended" : "issue.native_review_policy_restored",
      entityType: "issue", entityId: issue.id,
      details: { beforePolicy: issue.executionPolicy, afterPolicy: nextPolicy, postRevision: finalIssue.revision,
        statusVersion: issue.statusVersion, decisionId: decision.id, cardsSha256: cardPin, postCardsSha256,
        documentsSha256: e.expectedDocumentsSha256, executionBoundarySha256,
        retainedInteractionIds: cards.map(c => c.id), retainedCards,
        restoredActivityId, migration: "explicit_approval_withdrawal_require_original_author_resubmission", deliveryCreated: false } });
    return { receipt: { activityId: audit.activity.id, issueRevision: finalIssue.revision, postCardsSha256,
      policySha256: nativeSha256(nextPolicy), retainedInteractionIds: cards.map(c => c.id), retainedCards,
      migration: "explicit_approval_withdrawal_require_original_author_resubmission", deliveryCreated: false,
      verdictRecorded: false, automaticRetry: false }, publication: audit.publication };
  });
  publishActivity(result.publication);
  return result.receipt;
}
