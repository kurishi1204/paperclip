import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { commitNativeStatusDecision, NativeStatusRaceError } from "./status-decision-committer.js";
import { pendingNativeGovernance } from "./native-run-finalizer.js";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  completionContracts, heartbeatRuns, issueThreadInteractions, issues,
  nativeRunFinalizations, nativeRunResults, statusDecisionEffects, statusDecisions,
  workAssessments, workspaceOperations, type Db,
} from "@paperclipai/db";
import { persistActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { enqueueTerminalIssueInteractionChatPublications } from "../chat-interaction-publications.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";

const reason = "native_completion_review_superseded_by_writer_result";
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}
function gateIds(decision: typeof statusDecisions.$inferSelect) {
  const effects = decision.decisionJson.effects;
  return Array.isArray(effects) ? effects.flatMap((effect) => {
    const gate = record(record(effect).gate);
    return gate.kind === "interaction" && isUuid(gate.id) ? [gate.id] : [];
  }) : [];
}

/**
 * A completed writer continuation may replace its own unstarted completion
 * review, never a verdict, human approval, or a reviewer that has begun work.
 * Retirement is durable; the regular reconciler binds the newer saved result
 * to a fresh independent review. No provider result or tool call is replayed.
 */
export async function retireSupersededCompletionReviews(db: Db, runIds?: string[]) {
  const candidates = await db.select({ runId: nativeRunFinalizations.runId })
    .from(nativeRunFinalizations)
    .innerJoin(issues, and(eq(issues.companyId, nativeRunFinalizations.companyId),
      eq(issues.id, nativeRunFinalizations.issueId), eq(issues.lastStatusDecisionId, nativeRunFinalizations.decisionId)))
    .innerJoin(statusDecisions, eq(statusDecisions.id, nativeRunFinalizations.decisionId))
    .where(and(eq(nativeRunFinalizations.phase, "committed"), eq(issues.status, "in_review"),
      eq(statusDecisions.reasonCode, "governed_gate_pending"),
      ...(runIds?.length ? [inArray(nativeRunFinalizations.runId, runIds)] : [])))
    .catch((err) => { logger.warn({ err }, "Completion review handoff lookup failed; normal recovery continues"); return []; });
  for (const candidate of candidates) {
    const publications: ActivityPublication[] = [];
    try {
    await db.transaction(async (tx) => {
      // Same lock order as status commit and native reconciliation.
      const [coordinator] = await tx.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, candidate.runId)).for("update");
      if (!coordinator || coordinator.phase !== "committed" || !coordinator.decisionId) return;
      const scope = { companyId: coordinator.companyId, issueId: coordinator.issueId };
      const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, scope.companyId),
        eq(issues.id, scope.issueId))).for("update");
      if (!issue || issue.status !== "in_review" || issue.lastStatusDecisionId !== coordinator.decisionId
        || issue.checkoutRunId || issue.executionRunId || record(issue.executionState).status === "pending") return;
      const [decision] = await tx.select().from(statusDecisions).where(and(eq(statusDecisions.id, coordinator.decisionId),
        eq(statusDecisions.companyId, scope.companyId), eq(statusDecisions.issueId, scope.issueId),
        eq(statusDecisions.runId, coordinator.runId)));
      if (!decision || decision.reasonCode !== "governed_gate_pending" || decision.applicationState !== "applied"
        || decision.decisionJson.projectedStatusVersion !== issue.statusVersion) return;
      const [assessment] = await tx.select().from(workAssessments).where(and(eq(workAssessments.id, decision.assessmentId),
        eq(workAssessments.companyId, scope.companyId), eq(workAssessments.issueId, scope.issueId),
        eq(workAssessments.runId, coordinator.runId)));
      if (!assessment || assessment.id !== coordinator.assessmentId || assessment.resultId !== coordinator.resultId) return;
      const requests = assessment.assessmentJson.attentionRequests;
      if (!Array.isArray(requests) || requests.length !== 1) return;
      const request = record(requests[0]);
      if (request.kind !== "review" || request.ownerClass !== "agent"
        || typeof request.targetAgentId !== "string" || request.targetAgentId === issue.assigneeAgentId) return;
      const [result] = await tx.select().from(nativeRunResults).where(and(eq(nativeRunResults.id, assessment.resultId),
        eq(nativeRunResults.companyId, scope.companyId), eq(nativeRunResults.issueId, scope.issueId),
        eq(nativeRunResults.runId, coordinator.runId), eq(nativeRunResults.schemaStatus, "accepted")));
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, coordinator.runId),
        eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.nativeIssueId, scope.issueId)));
      const [contract] = await tx.select().from(completionContracts).where(and(eq(completionContracts.companyId, scope.companyId),
        eq(completionContracts.issueId, scope.issueId))).orderBy(desc(completionContracts.revision)).limit(1);
      const [barrier] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, scope.companyId),
        eq(workspaceOperations.heartbeatRunId, coordinator.runId), eq(workspaceOperations.phase, "workspace_finalize")))
        .orderBy(desc(workspaceOperations.createdAt)).limit(1);
      if (!result || result.completionContractId !== assessment.contractId || !contract || contract.id !== assessment.contractId
        || !run || run.status !== "succeeded" || run.agentId !== issue.assigneeAgentId
        || !run.startedAt || !run.finishedAt || barrier?.status !== "succeeded") return;
      const ids = gateIds(decision);
      if (ids.length !== 1) return;
      const [card] = await tx.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, ids[0]!),
        eq(issueThreadInteractions.companyId, scope.companyId), eq(issueThreadInteractions.issueId, scope.issueId))).for("update");
      const target = record(record(card?.payload).target);
      if (!card || card.status !== "pending" || card.kind !== "request_confirmation"
        || card.requestedResolverPolicy !== "anyone" || card.effectiveResolverPolicy !== "anyone"
        || card.createdByAgentId || card.createdByUserId || card.addresseeAgentId !== request.targetAgentId
        || card.addresseeUserId || card.continuationPolicy !== "wake_assignee"
        || target.type !== "custom" || target.key !== "native_completion_review"
        || !isUuid(target.revisionId) || !card.sourceRunId || card.sourceRunId === run.id) return;
      const [prior] = await tx.select().from(statusDecisions).where(and(eq(statusDecisions.id, target.revisionId),
        eq(statusDecisions.companyId, scope.companyId), eq(statusDecisions.issueId, scope.issueId),
        eq(statusDecisions.runId, card.sourceRunId), eq(statusDecisions.applicationState, "applied")));
      if (!prior) return;
      const [binding] = await tx.select().from(statusDecisionEffects).where(and(eq(statusDecisionEffects.decisionId, prior.id),
        eq(statusDecisionEffects.companyId, scope.companyId), eq(statusDecisionEffects.issueId, scope.issueId),
        eq(statusDecisionEffects.effectKind, "bind_reviewer"), eq(statusDecisionEffects.targetType, "issue_thread_interaction"),
        eq(statusDecisionEffects.targetId, card.id)));
      const [priorRun] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, card.sourceRunId),
        eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.nativeIssueId, scope.issueId)));
      const [priorAssessment] = await tx.select().from(workAssessments).where(and(eq(workAssessments.id, prior.assessmentId),
        eq(workAssessments.companyId, scope.companyId), eq(workAssessments.issueId, scope.issueId),
        eq(workAssessments.runId, card.sourceRunId)));
      if (!binding || !priorRun || priorRun.status !== "succeeded" || priorRun.agentId !== run.agentId
        || !priorRun.finishedAt || priorRun.finishedAt > run.startedAt || priorAssessment?.contractId !== assessment.contractId) return;
      const priorRequests = priorAssessment.assessmentJson.attentionRequests;
      if (!Array.isArray(priorRequests) || priorRequests.length !== 1) return;
      const priorRequest = record(priorRequests[0]);
      if (priorRequest.kind !== "review" || priorRequest.ownerClass !== "agent"
        || priorRequest.targetAgentId !== request.targetAgentId) return;
      // A scoped review can still have legacy/unresolved mode before its first
      // dispatch, so inspect all modes and both persisted issue identities.
      const runs = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, scope.companyId), or(
        eq(heartbeatRuns.nativeIssueId, scope.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${scope.issueId}`)));
      if (runs.some((entry) => ["queued", "running"].includes(entry.status))) return;
      const attempts = runs.filter((entry) => record(entry.contextSnapshot).nativeReviewInteractionId === card.id);
      if (attempts.some((entry) => entry.status !== "cancelled" || entry.errorCode !== "issue_assignee_changed"
        || entry.startedAt || entry.runtimeModeResolvedAt || entry.processPid || entry.processGroupId
        || entry.processStartedAt || entry.nativeSessionId || entry.externalRunId)) return;
      const now = new Date();
      await tx.update(issueThreadInteractions).set({ status: "cancelled", resolvedAt: now, updatedAt: now,
        result: { version: 1, outcome: "withdrawn", reason } }).where(and(
        eq(issueThreadInteractions.id, card.id), eq(issueThreadInteractions.status, "pending")));
      const projected = await issueThreadInteractionService(tx as unknown as Db).getById(card.id);
      if (projected) await enqueueTerminalIssueInteractionChatPublications(tx as unknown as Db, projected);
      const { publication } = await persistActivity(tx as unknown as Db, {
        companyId: scope.companyId, actorType: "system", actorId: "native-review-version-handoff",
        action: "issue.interaction_cancelled", entityType: "issue", entityId: scope.issueId,
        issueId: scope.issueId, runId: run.id, details: { source: reason, interactionId: card.id,
          priorDecisionId: prior.id, replacementDecisionId: decision.id, replacementResultId: result.id },
      });
      publications.push(publication);
    });
    } catch (err) {
      logger.warn({ err, runId: candidate.runId }, "Completion review handoff candidate failed; normal recovery continues");
      continue;
    }
    for (const publication of publications) {
      try { publishActivity(publication); } catch (err) {
        logger.warn({ err, runId: candidate.runId }, "Committed review retirement publication failed; durable handoff remains recoverable");
      }
    }
  }
}

/** Survives a restart after retirement but before the new review is committed. */
export async function decisionHasSupersededCompletionReview(db: Db, decision: typeof statusDecisions.$inferSelect) {
  const ids = gateIds(decision);
  if (ids.length !== 1) return false;
  const [row] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, ids[0]!), eq(issueThreadInteractions.companyId, decision.companyId),
    eq(issueThreadInteractions.issueId, decision.issueId), eq(issueThreadInteractions.status, "cancelled"),
    sql`${issueThreadInteractions.result}->>'reason' = ${reason}`,
    sql`${issueThreadInteractions.sourceRunId} <> ${decision.runId}::uuid`,
  ));
  return !!row;
}

/** Revalidate a saved-result transition while holding the execution authority locks. */
export async function commitVersionBoundReconciliation(input: {
  commit: Parameters<typeof commitNativeStatusDecision>[0];
  expectedAssigneeAgentId: string;
  contractId: string;
}) {
  const expected = input.commit;
  // Decorate the committer's own transaction factory rather than nesting a
  // second transaction around it. Its normal publication flush therefore
  // still happens only after the real outermost commit.
  const guardedTransaction: Db["transaction"] = async (callback, config) => expected.db.transaction(async (tx) => {
    const [coordinator] = await tx.select().from(nativeRunFinalizations)
      .where(and(eq(nativeRunFinalizations.runId, expected.runId), eq(nativeRunFinalizations.companyId, expected.companyId)))
      .for("update");
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, expected.issueId),
      eq(issues.companyId, expected.companyId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, expected.runId),
      eq(heartbeatRuns.companyId, expected.companyId), eq(heartbeatRuns.nativeIssueId, expected.issueId))).for("update");
    const [contract] = await tx.select({ id: completionContracts.id }).from(completionContracts)
      .where(and(eq(completionContracts.companyId, expected.companyId), eq(completionContracts.issueId, expected.issueId)))
      .orderBy(desc(completionContracts.revision)).limit(1);
    if (!coordinator || coordinator.phase !== "committed" || coordinator.decisionId !== expected.supersedesCommittedDecisionId
      || !issue || issue.assigneeAgentId !== input.expectedAssigneeAgentId || issue.executionRunId || issue.checkoutRunId
      || record(issue.executionState).status === "pending" || !run || run.status !== "succeeded"
      || run.agentId !== input.expectedAssigneeAgentId || contract?.id !== input.contractId) throw new NativeStatusRaceError();
    const active = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, expected.companyId), inArray(heartbeatRuns.status, ["queued", "running"]),
      or(eq(heartbeatRuns.nativeIssueId, expected.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${expected.issueId}`),
    )).limit(1);
    if (active.length || await pendingNativeGovernance({
      db: tx as unknown as Db, companyId: expected.companyId, issueId: expected.issueId,
      runId: expected.runId, executionState: record(issue.executionState),
    })) throw new NativeStatusRaceError();
    if (expected.decision.statusAction === "done" && (await issueService(tx as unknown as Db)
      .getDependencyReadiness(expected.issueId, tx as unknown as Db)).unresolvedBlockerCount > 0) throw new NativeStatusRaceError();
    // The original committer callback runs under these same authority locks.
    return callback(tx);
  }, config);
  const guardedDb = new Proxy(expected.db, {
    get(target, key) {
      if (key === "transaction") return guardedTransaction;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return commitNativeStatusDecision({ ...expected, db: guardedDb });
}
