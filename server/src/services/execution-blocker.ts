import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { and, desc, eq, gt, inArray, not, or, sql } from "drizzle-orm";
import { conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { z } from "zod";
import { agentWakeupRequests, chatConversations, chatEndpoints, heartbeatRuns, issueComments, issues, issueRecoveryActions, toolConnections, type Db } from "@paperclipai/db";
import { canContinueCancelledRun, readRunCancellation } from "./run-cancellation.js";
import { canRetryStoppedRun } from "./cancelled-native-startup.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";
import { EXECUTION_RECONCILIATION_CAUSES, hasWorkspaceRestoreFailure, type ExecutionBlocker } from "@paperclipai/shared";
import { hasSelfTaskDocumentReplayHold } from "./self-task-document-runtime.js";
import { isAuthorizedQaDecisionWake, qaDecisionWakeKey } from "./qa-decision-wake.js";

/** Read projection only. This is not an execution-admission or retry authority.
 * A QA wait need not contain a user comment; use the existing task notice rather
 * than hiding it in the comment queue's non-empty-entry presentation contract.
 */
export async function getQaPredecessorWaitBlocker(db: Db, companyId: string, issueId: string): Promise<ExecutionBlocker | null> {
  const [entry] = await db.select({
    runId: heartbeatRuns.id, agentId: heartbeatRuns.agentId, payload: agentWakeupRequests.payload,
  }).from(heartbeatRuns).innerJoin(issues, and(
    eq(issues.companyId, heartbeatRuns.companyId), eq(issues.id, issueId),
    eq(issues.executionRunId, heartbeatRuns.id),
  )).innerJoin(agentWakeupRequests, and(
    eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
    eq(agentWakeupRequests.runId, heartbeatRuns.id), eq(agentWakeupRequests.companyId, heartbeatRuns.companyId),
    eq(agentWakeupRequests.agentId, heartbeatRuns.agentId),
  )).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued"),
    sql`${agentWakeupRequests.idempotencyKey} = 'qa-decision:' || (${heartbeatRuns.contextSnapshot}->>'qaDecisionId')`,
    sql`${agentWakeupRequests.payload}->'executionWait'->>'reason' = 'qa_predecessor_ownership_active'`,
  )).limit(1);
  const wait = entry?.payload?.executionWait as Record<string, unknown> | undefined;
  if (!entry || typeof wait?.message !== "string") return null;
  return { recoveryActionId: null, runId: entry.runId, agentId: entry.agentId,
    cause: "qa_predecessor_ownership_active", runStatus: "queued", runError: wait.message,
    nextAction: "前の実行の停止と後始末を確認してください。受領が確認できれば、同じ判断に基づく新しい作業を再開します。",
    canContinue: false, canRetry: false,
  };
}

/** A new committed QA return can coexist with old document UNKNOWN receipts.
 * Call under the issue lock, at both admission and final queued-run validation.
 * This does not resolve a recovery action or authorize replay of the old run.
 */
export async function isIndependentQaDocumentEpisode(db: Db, input: {
  companyId: string; issueId: string; agentId: string; decisionId: string; runId?: string;
}): Promise<boolean> {
  if (!z.string().guid().safeParse(input.decisionId).success ||
      !await isAuthorizedQaDecisionWake(db, input)) return false;
  if (input.runId) {
    const [run] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'qaDecisionId' = ${input.decisionId}`,
    )).limit(1);
    const [wake] = run?.wakeupRequestId ? await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId), eq(agentWakeupRequests.runId, run.id),
      eq(agentWakeupRequests.idempotencyKey, qaDecisionWakeKey(input.decisionId)),
    )).limit(1) : [];
    if (!wake) return false;
  }
  const actions = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    executionBlockerPredicate(),
  )).for("update");
  if (!actions.length) return false;
  for (const action of actions) {
    const evidence = action.evidence;
    const runId = z.string().guid().safeParse(evidence.runId ?? evidence.sourceRunId);
    if (!runId.success || evidence.workspaceRestoreFailure === "restore_unsafe_archive") return false;
    const [run] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, runId.data), eq(heartbeatRuns.companyId, input.companyId),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId',
        ${heartbeatRuns.contextSnapshot}->>'taskId') = ${input.issueId}`,
    )).limit(1);
    if (!run || !["succeeded", "interrupted", "failed", "cancelled", "timed_out"].includes(run.status) ||
        !hasSelfTaskDocumentReplayHold(run) || hasWorkspaceRestoreFailure(run.resultJson)) return false;
  }
  return true;
}

/** Resolved recovery bookkeeping can still carry an effective no-replay hold. */
export function executionBlockerPredicate() {
  return and(
    not(conversationRecoveryActionPredicate()!),
    inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
    or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`),
  );
}

export async function getExecutionBlocker(db: Db, companyId: string, issueId: string, options?: { conversationResetCommentId?: string | null }): Promise<ExecutionBlocker | null> {
  const [conversation] = await db.select({ agentId: issues.conversationAgentId,
    boundaryId: issues.conversationBoundaryCommentId, status: issues.status,
    assigneeAgentId: issues.assigneeAgentId }).from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  )).limit(1);
  // Resetting model context cannot make an unsafe workspace safe. This hold
  // survives conversation boundaries until the existing repair/reconciliation path clears it.
  const [restoreHold] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
    sql`${issueRecoveryActions.evidence}->>'workspaceRestoreFailure' = 'restore_unsafe_archive'`,
  )).orderBy(desc(issueRecoveryActions.updatedAt)).limit(1);
  // A persisted user /new is an ordered context command, not a retry of uncertain work.
  // The normal issue execution lock still serializes it behind any active turn.
  if (!restoreHold && conversation?.agentId && options?.conversationResetCommentId) {
    const [command] = await db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.id, options.conversationResetCommentId),
    )).limit(1);
    if (command?.authorUserId && !command.deletedAt && command.body.trim() === "/new") return null;
  }
  const [boundary] = conversation?.agentId && conversation.boundaryId
    ? await db.select({ createdAt: issueComments.createdAt }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.id, conversation.boundaryId),
    )).limit(1) : [];

  const ownership = await getConversationOwnershipBlocker(db, companyId, issueId);
  if (ownership) return { ...ownership, recoveryActionId: null };
  const [action] = restoreHold ? [restoreHold] : await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
    boundary ? gt(issueRecoveryActions.createdAt, boundary.createdAt) : undefined,
  )).orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id)).limit(1);
  if (!action) return null;
  const parsedRunId = z.string().guid().safeParse(action.evidence.runId ?? action.evidence.sourceRunId);
  const runId = parsedRunId.success ? parsedRunId.data : null;
  const [run] = runId ? await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
  )).limit(1) : [];
  const queue = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
  ));
  const savedIds = [...new Set(queue.flatMap(entry => {
    const context = entry.payload?._paperclipWakeContext as Record<string, unknown> | undefined;
    return [...queuedCommentIdsFromWakePayload(entry.payload), entry.payload?.commentId, context?.wakeCommentId]
      .filter((id): id is string => z.string().guid().safeParse(id).success);
  }))];
  const saved = savedIds.length ? await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    inArray(issueComments.id, savedIds), eq(issueComments.authorType, "user"), sql`${issueComments.deletedAt} is null`,
    sql`not exists (select 1 from ${heartbeatRuns} consumed where consumed.company_id = ${companyId}
      and consumed.context_snapshot->>'issueId' = ${issueId}
      and not (consumed.status = 'cancelled' and consumed.started_at is null)
      and (consumed.context_snapshot->>'wakeCommentId' = ${issueComments.id}::text
        or consumed.context_snapshot->'wakeCommentIds' @> jsonb_build_array(${issueComments.id}::text)))`,
  )) : [];
  const cancellation = run ? readRunCancellation(run.resultJson) : null;
  const eligibleContinuation = Boolean(run && conversation?.assigneeAgentId === run.agentId &&
    !["done", "cancelled"].includes(conversation.status) && canContinueCancelledRun(run));
  const canRetry = Boolean(run && conversation?.assigneeAgentId === run.agentId &&
    !["done", "cancelled"].includes(conversation.status) && await canRetryStoppedRun(db, run));
  const runError = run && canRetry && isPreDispatchReviewWait(run)
    ? "Waiting for review; this continuation never started."
    : cancellation?.reason ?? (run?.status === "cancelled"
      ? "Execution was cancelled; its source was not recorded."
      : run?.error);
  const [chatBinding] = eligibleContinuation || canRetry ? await db.select({
    state: chatConversations.state, endpointStatus: chatEndpoints.status,
    connectionStatus: toolConnections.status, connectionEnabled: toolConnections.enabled,
  }).from(chatConversations).leftJoin(chatEndpoints, and(
    eq(chatEndpoints.companyId, companyId), eq(chatEndpoints.id, chatConversations.endpointId),
  )).leftJoin(toolConnections, and(
    eq(toolConnections.companyId, companyId), eq(toolConnections.id, chatEndpoints.connectionId),
  )).where(and(
    eq(chatConversations.companyId, companyId), eq(chatConversations.issueId, issueId),
  )).limit(1) : [];
  let nextAction = action.nextAction;
  if (canRetry && !eligibleContinuation) nextAction += " Try again or send a new message to continue once the previous execution has stopped.";
  if (chatBinding) {
    if (chatBinding.state === "endpoint_removed" || !chatBinding.endpointStatus || chatBinding.endpointStatus === "archived") {
      nextAction = "This chat connection was removed. Inspect the stopped run and create a new task to continue the work.";
    } else if (chatBinding.state === "unavailable" || !["active", "verifying"].includes(chatBinding.endpointStatus) ||
        chatBinding.connectionStatus !== "active" || !chatBinding.connectionEnabled) {
      nextAction = "This chat connection is unavailable. Restore access in Apps or create a new task to continue the work.";
    } else {
      nextAction = "Send a new chat message to continue this conversation.";
    }
  } else if (run?.status === "cancelled" && !eligibleContinuation && !canRetry && action.cause === "legacy_execution_requires_reconciliation") {
    nextAction += " Inspect the run before sending a new message to request continuation.";
  }

  return {
    recoveryActionId: action.id,
    runId,
    // A stopped reviewer can differ from the task owner who receives the work back.
    agentId: run?.agentId ?? null,
    cause: action.cause,
    nextAction,
    runStatus: run?.status ?? null,
    runError: runError?.slice(0, 1024) ?? null,
    canContinue: eligibleContinuation && !chatBinding,
    canRetry: canRetry && !chatBinding,
    savedMessageCount: saved.length,
  };
}
