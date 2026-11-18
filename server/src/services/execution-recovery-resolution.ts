import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { randomUUID } from "node:crypto";
import { claimedAdapterType, conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { persistActivity } from "./activity-log.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { logger } from "../middleware/logger.js";
import { and, eq, inArray, isNull, isNotNull, not, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  chatActions,
  environmentLeases,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import {
  EXECUTION_RECONCILIATION_CAUSES,
  type ExecutionReconciliation,
} from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isSupersededConversationRun } from "./agent-conversations.js";

/** Called under the issue lock; completing recorded work cannot consume a live path. */
export async function assertTerminalReconciliationIdle(db: Db, task: typeof issues.$inferSelect) {
  if (task.executionRunId || task.checkoutRunId ||
      (task.executionPolicy != null && parseIssueExecutionState(task.executionState)?.status !== "completed") ||
      (task.executionState != null && parseIssueExecutionState(task.executionState)?.status !== "completed")) {
    throw conflict("Terminal reconciliation cannot bypass execution ownership or an unfinished review.");
  }
  const [liveRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, task.companyId),
    or(eq(heartbeatRuns.nativeIssueId, task.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`,
      sql`${heartbeatRuns.contextSnapshot}->>'taskId' = ${task.id}`),
    or(inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      isNotNull(heartbeatRuns.scheduledRetryAt)),
  )).limit(1);
  const [wake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, task.companyId),
    inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
    sql`(${agentWakeupRequests.payload}->>'issueId' = ${task.id}
      or ${agentWakeupRequests.payload}->>'taskId' = ${task.id}
      or ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId' = ${task.id}
      or ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId' = ${task.id})`,
  )).limit(1);
  if (liveRun || wake) throw conflict("Terminal reconciliation requires all task execution and queued delivery to be stopped.");
}

/** An operator records observed outcomes; this is not permission to blindly retry. */
export async function validateExecutionReconciliation(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string | null;
  sourceRunId: unknown;
  decision: ExecutionReconciliation | undefined;
  terminal?: boolean;
}) {
  const { db, companyId, issueId, agentId, decision } = input;
  if (!decision || decision.providerStopped !== true || decision.runId !== input.sourceRunId || !agentId) {
    throw conflict(
      "Reconcile the recorded execution and its action outcomes before continuing this task.",
    );
  }
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.id, decision.runId),
      ),
    );
  const [task] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  const review =
    task?.status === "in_review"
      ? parseIssueExecutionState(task.executionState)
      : null;
  const isCurrentReviewer =
    review?.status === "pending" &&
    review.currentParticipant?.type === "agent" &&
    review.currentParticipant.agentId === run?.agentId;
  if (
    !run ||
    !task ||
    task.assigneeAgentId !== agentId ||
    (run.agentId !== agentId && !isCurrentReviewer) ||
    (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issueId ||
    !["failed", "interrupted", "timed_out", "cancelled"].includes(run.status)
  ) {
    throw conflict(
      "The recovery source or task owner changed. Inspect the current execution before continuing.",
    );
  }
  if (input.terminal) {
    if (task.status !== "blocked" || run.agentId !== agentId ||
        (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt.getTime() > Date.now())) {
      throw conflict("Terminal reconciliation requires the stopped source run and unchanged blocked owner.");
    }
    await assertTerminalReconciliationIdle(db, task);
  }
  if (hasWorkspaceRestoreFailure(run.resultJson) &&
      (!decision.workspaceRepairEvidence || decision.workspaceRepairEvidence.trim().length < 20)) {
    throw conflict("Verify safe workspace staging or repair and record workspaceRepairEvidence before continuing this run.");
  }
  for (const pid of [
    run.processPid,
    run.processGroupId ? -run.processGroupId : null,
  ]) {
    if (!pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw conflict(
        "The previous provider's process ownership cannot be verified.",
      );
    }
    throw conflict(
      "The previous provider is still running. Stop it before continuing.",
    );
  }
  const [coordinator] = await db
    .select()
    .from(nativeRunFinalizations)
    .where(
      and(
        eq(nativeRunFinalizations.companyId, companyId),
        eq(nativeRunFinalizations.runId, run.id),
      ),
    );
  if (coordinator?.leaseOwner || coordinator?.failureDetail?.successorRunId)
    throw conflict(
      "This execution still has a coordinator or a linked continuation. Inspect that run first.",
    );
  if (input.terminal && coordinator &&
      (!["committed", "terminal_failure"].includes(coordinator.phase) || coordinator.nextAttemptAt)) {
    throw conflict("Terminal reconciliation requires finalization to be settled without scheduled work.");
  }
  const leases = await db
    .select({ id: environmentLeases.id })
    .from(environmentLeases)
    .where(
      and(
        eq(environmentLeases.companyId, companyId),
        eq(environmentLeases.heartbeatRunId, run.id),
        isNull(environmentLeases.releasedAt),
      ),
    )
    .limit(1);
  if (leases.length)
    throw conflict(
      "The previous execution environment has not finished releasing its authority.",
    );
  await buildExecutionContinuation({
    db,
    companyId,
    issueId,
    agentId,
    context: { previousRunId: run.id },
    summary: null,
    exposeLowTrustRaw: false,
  });
  return run;
}

/** Durable delivery marker lives on the existing source-scoped recovery action. */
export async function markExecutionReconciliation(
  db: Db,
  action: Pick<
    typeof issueRecoveryActions.$inferSelect,
    "companyId" | "id" | "evidence" | "sourceIssueId"
  >,
  decision: ExecutionReconciliation,
  actorId: string,
  deliveryOwner?: { kind: "chat_failed_run_retry"; actionId: string }
    | { kind: "terminal"; expectedSourceRevision: number; issueRevision: number; assigneeAgentId: string },
) {
  const terminal = deliveryOwner?.kind === "terminal";
  if (deliveryOwner?.kind === "chat_failed_run_retry") {
    const [retry] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, action.companyId),
          eq(chatActions.id, deliveryOwner.actionId),
        ),
      );
    if (
      deliveryOwner.kind !== "chat_failed_run_retry" ||
      !retry ||
      retry.kind !== "failed_run_retry" ||
      !["issued", "processing", "processed"].includes(retry.status) ||
      retry.payload.version !== 1 ||
      retry.payload.failedRunId !== decision.runId ||
      retry.payload.issueId !== action.sourceIssueId
    ) {
      throw conflict("The authorized chat retry owner is no longer valid.");
    }
  }
  if (!terminal) await db
    .update(nativeRunFinalizations)
    .set({
      failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb) || ${JSON.stringify({ replacementDenied: "operator_reconciled" })}::jsonb`,
    })
    .where(
      and(
        eq(nativeRunFinalizations.companyId, action.companyId),
        eq(nativeRunFinalizations.runId, decision.runId),
      ),
    );
  await db
    .update(issueRecoveryActions)
    .set({
      evidence: {
        ...action.evidence,
        ...(terminal ? {} : { automaticRecovery: undefined }),
        executionReconciliation: {
          ...decision,
          actorId,
          recordedAt: new Date().toISOString(),
        },
        continuationDelivery: terminal ? "terminal" : deliveryOwner ? "delegated" : "pending",
        ...(deliveryOwner?.kind === "chat_failed_run_retry" ? { continuationDeliveryOwner: deliveryOwner } : {}),
        ...(deliveryOwner?.kind === "terminal" ? { terminalReconciliation: {
          sourceIssueStatus: "done", expectedSourceRevision: deliveryOwner.expectedSourceRevision, issueRevision: deliveryOwner.issueRevision,
          assigneeAgentId: deliveryOwner.assigneeAgentId,
        } } : {}),
      },
    })
    .where(
      and(
        eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.id, action.id),
      ),
    );
}

export async function deliverReconciledExecutions(
  db: Db,
  wake: ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"],
) {
  const pending = await db
    .select()
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
      ),
    )
    .limit(25);
  for (const action of pending) {
    try {
      const decision = action.evidence.executionReconciliation as
        ExecutionReconciliation | undefined;
      if (!decision || !action.returnOwnerAgentId) continue;
      const pendingDecision = and(
        eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.id, action.id),
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
        sql`${issueRecoveryActions.evidence}->'executionReconciliation' = ${JSON.stringify(decision)}::jsonb`,
      );
      const [task] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, action.companyId),
            eq(issues.id, action.sourceIssueId),
          ),
        );
      if (
        !task ||
        task.assigneeAgentId !== action.returnOwnerAgentId ||
        ["done", "cancelled"].includes(task.status)
      ) {
        await db
          .update(issueRecoveryActions)
          .set({
            evidence: sql`${issueRecoveryActions.evidence} || '{"continuationDelivery":"invalidated"}'::jsonb`,
          })
          .where(pendingDecision);
        continue;
      }
      const run = await wake(action.returnOwnerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_recovery_action_restored",
        idempotencyKey: `execution-reconciliation:${action.id}`,
        payload: { issueId: task.id, recoveryActionId: action.id },
        requestedByActorType: "system",
        requestedByActorId: "execution-recovery",
        contextSnapshot: {
          issueId: task.id,
          taskId: task.id,
          recoveryActionId: action.id,
          previousRunId: decision.runId,
          retryOfRunId: decision.runId,
          forceFreshSession: true,
          wakeReason: "issue_recovery_action_restored",
          source: "execution.reconciled",
        },
      });
      if (run)
        await db.transaction(async (tx) => {
          await tx
            .update(heartbeatRuns)
            .set({ retryOfRunId: decision.runId })
            .where(
              and(
                eq(heartbeatRuns.companyId, action.companyId),
                eq(heartbeatRuns.id, run.id),
                eq(heartbeatRuns.agentId, action.returnOwnerAgentId!),
                sql`${heartbeatRuns.contextSnapshot}->>'recoveryActionId' = ${action.id}`,
                sql`${heartbeatRuns.contextSnapshot}->>'previousRunId' = ${decision.runId}`,
              ),
            );
          await tx
            .update(issueRecoveryActions)
            .set({
              evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify(
                {
                  continuationDelivery: "delivered",
                  continuationRunId: run.id,
                },
              )}::jsonb`,
            })
            .where(pendingDecision);
        });
    } catch {
      logger.warn(
        { recoveryActionId: action.id },
        "Reconciled execution continuation remains pending for retry",
      );
    }
  }
}

/**
 * Failed execution is a system responsibility, not a user questionnaire. After
 * automatic recovery is ruled out, preserve evidence and stop without replay.
 * This is NOT evidence that an external action succeeded or never happened.
 * The resolved record retains a dispatch hold until actual evidence clears it.
 */
export async function settleUnrecoverableExecutions(
  db: Db,
  now = new Date(),
  options: { failpoint?: (phase: "persisted") => void } = {},
) {
  // Fold obsolete conversation holds without waking historical work on upgrade.
  // Keep their evidence and record the policy change in the task's activity log.
  const obsoleteConversationHold = and(
    conversationRecoveryActionPredicate(),
    // An explicit reconciliation is a durable decision, not an obsolete hold.
    // Terminal receipts deliberately retain the original blocked replay evidence.
    sql`not (${issueRecoveryActions.evidence} ? 'executionReconciliation')`,
    or(
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    ),
  );
  await db.transaction(async tx => {
    const foldable = await tx.select().from(issueRecoveryActions).where(obsoleteConversationHold)
      .limit(25).for("update", { skipLocked: true });
    for (const candidate of foldable) {
      if (await getConversationOwnershipBlocker(tx as unknown as Db, candidate.companyId, candidate.sourceIssueId)) continue;
      const [action] = await tx.update(issueRecoveryActions).set({
        status: "resolved",
        outcome: "cancelled",
        resolvedAt: now,
        updatedAt: now,
        nextAction: "Automatic attempts stopped. Send a new message to continue the conversation.",
        resolutionNote: "Conversation continuation does not replay prior tool calls.",
        wakePolicy: null,
        monitorPolicy: null,
        evidence: sql`case when ${issueRecoveryActions.evidence} ? 'automaticRecovery'
          then jsonb_set(${issueRecoveryActions.evidence}, '{automaticRecovery,replay}', '"conversation_continuation"'::jsonb)
          else ${issueRecoveryActions.evidence} end`,
      }).where(and(obsoleteConversationHold, eq(issueRecoveryActions.id, candidate.id))).returning();
      if (!action) continue;
      await persistActivity(tx as unknown as Db, {
        companyId: action.companyId,
        actorType: "system",
        actorId: "execution-recovery",
        action: "issue.execution_recovery_settled",
        entityType: "issue",
        entityId: action.sourceIssueId,
        details: { recoveryActionId: action.id, outcome: "cancelled", continuation: "conversation" },
      });
    }
  });
  // Filter eligibility before applying the batch limit. A queue of sessions
  // awaiting replacement must not starve settled incidents behind it.
  const candidates = await db
    .select({ action: issueRecoveryActions })
    .from(issueRecoveryActions)
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
        sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'`,
        sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text`,
      ),
    )
    .leftJoin(
      nativeRunFinalizations,
      and(
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      ),
    )
    .where(
      and(
        not(conversationRecoveryActionPredicate()!),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        eq(issueRecoveryActions.kind, "active_run_watchdog"),
        inArray(issueRecoveryActions.cause, [
          ...EXECUTION_RECONCILIATION_CAUSES,
        ]),
        inArray(heartbeatRuns.status, [
          "failed",
          "timed_out",
          "interrupted",
          "cancelled",
        ]),
        isNull(nativeRunFinalizations.leaseOwner),
        isNull(nativeRunFinalizations.resultId),
        or(
          isNull(nativeRunFinalizations.runId),
          eq(nativeRunFinalizations.phase, "terminal_failure"),
        ),
        sql`coalesce(${nativeRunFinalizations.failureDetail}->>'successorRunId', '') = ''`,
        sql`(${heartbeatRuns.runtimeMode} <> 'native' or coalesce(${nativeRunFinalizations.failureCode}, '') <> 'native_provider_terminal_failed'
        or coalesce(${nativeRunFinalizations.failureDetail}->>'replacementDenied', '') <> '')`,
      ),
    )
    .limit(25);
  for (const { action: candidate } of candidates) {
    const runId = candidate.evidence.runId;
    if (typeof runId !== "string") continue;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
        );
        // Same issue -> coordinator -> run ordering as replacement/finalization.
        const [task] = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, candidate.companyId),
              eq(issues.id, candidate.sourceIssueId),
            ),
          )
          .for("update");
        const [coordinator] = await tx
          .select()
          .from(nativeRunFinalizations)
          .where(
            and(
              eq(nativeRunFinalizations.companyId, candidate.companyId),
              eq(nativeRunFinalizations.runId, runId),
            ),
          )
          .for("update");
        const [run] = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, candidate.companyId),
              eq(heartbeatRuns.id, runId),
            ),
          )
          .for("update");
        const [action] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.id, candidate.id))
          .for("update");
        if (
          !task ||
          !run ||
          !action ||
          action.evidence.runId !== runId ||
          !EXECUTION_RECONCILIATION_CAUSES.includes(
            action.cause as (typeof EXECUTION_RECONCILIATION_CAUSES)[number],
          ) ||
          !["active", "escalated"].includes(action.status) ||
          (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== task.id ||
          !["failed", "timed_out", "interrupted", "cancelled"].includes(
            run.status,
          )
        )
          return;
        // Give durable native recovery its chance; never preempt a resume,
        // replacement, result finalizer, or still-owned execution.
        if (
          coordinator?.leaseOwner ||
          coordinator?.resultId ||
          coordinator?.failureDetail?.successorRunId ||
          (coordinator && coordinator.phase !== "terminal_failure") ||
          (run.runtimeMode === "native" &&
            coordinator?.failureCode === "native_provider_terminal_failed" &&
            !coordinator.failureDetail?.replacementDenied)
        )
          return;
        const current =
          !isSupersededConversationRun(task, run) &&
          action.returnOwnerAgentId !== null &&
          task.assigneeAgentId === action.returnOwnerAgentId &&
          !["done", "cancelled"].includes(task.status) &&
          (!task.executionRunId || task.executionRunId === run.id) &&
          (!task.checkoutRunId || task.checkoutRunId === run.id);
        const note = current
          ? hasWorkspaceRestoreFailure(run.resultJson)
            ? "Workspace repair required. Verify safe staging or repair before continuing. Saved work and approval decisions remain in force."
            : "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated."
          : "Recovery closed because the task's owner, execution, or status changed. No work was replayed.";
        let nativeFailureBlock = action.evidence.nativeFailureBlock;
        let nativeBootstrapFailureBlock = action.evidence.nativeBootstrapFailureBlock;
        if (current) {
          const [projected] = await tx
            .update(issues)
            .set({
              status: "blocked",
              executionRunId: null,
              checkoutRunId: null,
              updatedAt: now,
            })
            .where(eq(issues.id, task.id)).returning();
          // Only a transition owned by this failure grants a recovery receipt.
          // An already-blocked task may have a separate human/dependency hold.
          if (task.status !== "blocked" && run.runtimeMode === "native") {
            nativeFailureBlock = { runId: run.id, statusVersion: projected!.statusVersion };
          }
          if (task.status !== "blocked" && run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt &&
              run.errorCode === "server_shutdown_interrupted" && claimedAdapterType(run) === "paperclip_runner") {
            nativeBootstrapFailureBlock = { runId: run.id, statusVersion: projected!.statusVersion, previousStatus: task.status };
          }
        }
        await tx
          .update(issueRecoveryActions)
          .set({
            status: "resolved",
            outcome: current ? "blocked" : "cancelled",
            resolvedAt: now,
            updatedAt: now,
            nextAction: note,
            resolutionNote: note,
            wakePolicy: null,
            monitorPolicy: null,
            evidence: {
              ...action.evidence,
              ...(nativeFailureBlock ? { nativeFailureBlock } : {}),
              ...(nativeBootstrapFailureBlock ? { nativeBootstrapFailureBlock } : {}),
              automaticRecovery: {
                policy: "preserve_without_replay_v1",
                runId: run.id,
                replay: "blocked",
                actionOutcome: "unknown",
                recordedAt: now.toISOString(),
              },
            },
          })
          .where(eq(issueRecoveryActions.id, action.id));
        await persistActivity(tx as unknown as Db, {
          companyId: run.companyId,
          actorType: "system",
          actorId: "execution-recovery",
          action: "issue.execution_recovery_settled",
          entityType: "issue",
          entityId: task.id,
          runId: run.id,
          details: {
            recoveryActionId: action.id,
            outcome: current ? "blocked" : "cancelled",
            replay: "not_authorized",
          },
        });
        await tx
          .update(heartbeatRuns)
          .set({ executionStatusDeliveryId: randomUUID() })
          .where(eq(heartbeatRuns.id, run.id));
        await appendHeartbeatRunEvent(tx as unknown as Db, {
          companyId: run.companyId,
          agentId: run.agentId,
          runId: run.id,
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: note,
          payload: {
            recoveryActionId: action.id,
            cause: action.cause,
            automaticRecovery: "preserve_without_replay_v1",
            replay: "blocked",
          },
        });
        options.failpoint?.("persisted");
      });
    } catch (err) {
      if (options.failpoint) throw err;
      logger.warn(
        { err, recoveryActionId: candidate.id },
        "Automatic recovery disposition remains pending",
      );
    }
  }
}
