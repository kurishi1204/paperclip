import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import type { IssueExecutionState } from "@paperclipai/shared";

const QA_DECISION_WAKE_PREFIX = "qa-decision:";

export function qaDecisionWakeKey(decisionId: string): string {
  return `${QA_DECISION_WAKE_PREFIX}${decisionId}`;
}

export function qaDecisionIdFromWakeKey(key: string | null | undefined): string | null {
  if (!key?.startsWith(QA_DECISION_WAKE_PREFIX)) return null;
  const id = key.slice(QA_DECISION_WAKE_PREFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

/** Project a host's current pre-provider observation, not an old result's claim.
 * Call only from the executing host's failure/deferral branch. A false flag must
 * mean this invocation never entered provider dispatch; this helper does not
 * inspect physical ownership or authorize delivery of another run.
 */
export function buildQaPreProviderRecovery(input: {
  run: { id: string; runtimeMode: string; contextSnapshot: unknown };
  kind: string;
  providerMayHaveStarted: boolean;
  existingRecovery?: Record<string, unknown> | null;
}) {
  const recovery = { ...input.existingRecovery };
  // Evidence belongs to one host observation and one run/decision pair. Never
  // carry another observation's stamp through a merge or a dispatch boundary.
  delete recovery.qaPreProvider;
  const providerWorkStarted = input.providerMayHaveStarted !== false || recovery.providerWorkStarted === true;
  const context = input.run.contextSnapshot && typeof input.run.contextSnapshot === "object"
    && !Array.isArray(input.run.contextSnapshot)
    ? input.run.contextSnapshot as Record<string, unknown> : {};
  const decisionId = typeof context.qaDecisionId === "string"
    ? qaDecisionIdFromWakeKey(qaDecisionWakeKey(context.qaDecisionId)) : null;
  return {
    ...recovery,
    kind: input.kind,
    providerWorkStarted,
    ...(!providerWorkStarted && input.run.runtimeMode === "legacy" &&
      context.forceFreshSession === true && decisionId
      ? { qaPreProvider: { schema: "paperclip.qa-pre-provider/v1" as const,
          runId: input.run.id, decisionId } }
      : {}),
  };
}

/** Project the normal changes-requested route context after decision authorization.
 * This does not authorize a wake. Admission must use the current locked issue
 * state after isAuthorizedQaDecisionWake, never a caller's old wake snapshot.
 */
export function buildQaChangesRequestedWakeContext(input: {
  issueId: string;
  state: Pick<IssueExecutionState,
    "currentStageId" | "currentStageType" | "currentParticipant" |
    "returnAssignee" | "reviewRequest" | "lastDecisionOutcome">;
  interruptedRunId?: string | null;
}) {
  const executionStage = {
    wakeRole: "executor" as const,
    stageId: input.state.currentStageId,
    stageType: input.state.currentStageType,
    currentParticipant: input.state.currentParticipant,
    returnAssignee: input.state.returnAssignee,
    reviewRequest: input.state.reviewRequest ?? null,
    lastDecisionOutcome: input.state.lastDecisionOutcome,
    allowedActions: ["address_changes", "resubmit"],
  };
  const interrupted = input.interruptedRunId ? { interruptedRunId: input.interruptedRunId } : {};
  return {
    payload: { issueId: input.issueId, mutation: "update" as const, executionStage, ...interrupted },
    contextSnapshot: {
      issueId: input.issueId,
      taskId: input.issueId,
      wakeReason: "execution_changes_requested" as const,
      source: "issue.execution_stage" as const,
      executionStage,
      ...interrupted,
    },
  };
}

/** A terminal receipt is retryable only when its complete linkage proves no provider work.
 * Keep this predicate shared by recovery selection and admission under the issue lock.
 * A claim is not provider dispatch. Claimed failures need an explicit server
 * pre-provider stamp as well as absence of every physical dispatch marker.
 * Missing, mismatched, active, or possibly dispatched evidence remains a fence.
 */
export function qaDecisionWakeBlocksDelivery() {
  const wake = agentWakeupRequests;
  return sql`not (
    ${wake.status} in ('failed','cancelled','skipped')
    and ${wake.finishedAt} is not null
    and (
      (${wake.runId} is null and ${wake.claimedAt} is null and not exists (
        select 1 from heartbeat_runs qa_other_run
        where qa_other_run.wakeup_request_id = ${wake.id}
      ))
      or (${wake.runId} is not null and exists (
        select 1 from heartbeat_runs qa_prior_run
        where qa_prior_run.id = ${wake.runId}
          and qa_prior_run.company_id = ${wake.companyId}
          and qa_prior_run.agent_id = ${wake.agentId}
          and qa_prior_run.wakeup_request_id = ${wake.id}
          and qa_prior_run.status in ('failed','cancelled')
          and (qa_prior_run.result_json #> '{executionRecovery,providerWorkStarted}') is distinct from 'true'::jsonb
          and (
            (${wake.claimedAt} is null and qa_prior_run.started_at is null
              and qa_prior_run.execution_status_delivery_id is null and qa_prior_run.controller_boot_id is null)
            or (
              qa_prior_run.runtime_mode = 'legacy'
              and qa_prior_run.result_json #>> '{executionRecovery,qaPreProvider,schema}' = 'paperclip.qa-pre-provider/v1'
              and qa_prior_run.result_json #>> '{executionRecovery,qaPreProvider,runId}' = qa_prior_run.id::text
              and qa_prior_run.result_json #>> '{executionRecovery,qaPreProvider,decisionId}' = split_part(${wake.idempotencyKey}, ':', 2)
              and
              qa_prior_run.result_json #> '{executionRecovery,providerWorkStarted}' = 'false'::jsonb
              and qa_prior_run.context_snapshot->>'qaDecisionId' = split_part(${wake.idempotencyKey}, ':', 2)
              and qa_prior_run.context_snapshot->'forceFreshSession' = 'true'::jsonb
            )
          )
          and qa_prior_run.finished_at is not null
          and qa_prior_run.process_started_at is null
          and qa_prior_run.process_pid is null
          and qa_prior_run.process_group_id is null
          and qa_prior_run.external_run_id is null
          and qa_prior_run.native_session_id is null
      ) and not exists (
        select 1 from heartbeat_runs qa_other_run
        where qa_other_run.wakeup_request_id = ${wake.id}
          and qa_other_run.id <> ${wake.runId}
      ))
    )
  )`;
}

/** A committed review decision is the authority; wake prose and actor labels are not. */
export function isCurrentQaChangesRequestedDecision(input: {
  companyId: string;
  issueId: string;
  agentId: string;
  decisionId: string;
  decision: {
    id: string; companyId: string; issueId: string; stageId: string;
    stageType: string; outcome: string; freshEpisodeWakeRequested: boolean;
  } | null;
  issue: {
    id: string; companyId: string; status: string;
    assigneeAgentId?: string | null;
    executionState: unknown;
  } | null;
}): boolean {
  const { companyId, issueId, agentId, decisionId, decision, issue } = input;
  if (!decision || !issue || decision.id !== decisionId ||
      decision.companyId !== companyId || decision.issueId !== issueId ||
      decision.stageType !== "review" || decision.outcome !== "changes_requested" ||
      decision.freshEpisodeWakeRequested !== true ||
      issue.id !== issueId || issue.companyId !== companyId || issue.status !== "in_progress" ||
      issue.assigneeAgentId !== agentId) return false;
  const state = issue.executionState;
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const value = state as Record<string, unknown>;
  const returnAssignee = value.returnAssignee;
  if (!returnAssignee || typeof returnAssignee !== "object" || Array.isArray(returnAssignee)) return false;
  const assignee = returnAssignee as Record<string, unknown>;
  return value.status === "changes_requested" &&
    value.currentStageId === decision.stageId && value.lastDecisionId === decisionId &&
    assignee.type === "agent" && assignee.agentId === agentId;
}

/** Call only after the issue row is locked, and re-call at queued claim. */
export async function isAuthorizedQaDecisionWake(db: Db, input: {
  companyId: string; issueId: string; agentId: string; decisionId: string;
}): Promise<boolean> {
  const [issue] = await db.select({
    id: issues.id, companyId: issues.companyId, status: issues.status,
    assigneeAgentId: issues.assigneeAgentId, executionState: issues.executionState,
  }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).limit(1);
  const [decision] = await db.select({
    id: issueExecutionDecisions.id, companyId: issueExecutionDecisions.companyId,
    issueId: issueExecutionDecisions.issueId, stageId: issueExecutionDecisions.stageId,
    stageType: issueExecutionDecisions.stageType, outcome: issueExecutionDecisions.outcome,
    freshEpisodeWakeRequested: issueExecutionDecisions.freshEpisodeWakeRequested,
  }).from(issueExecutionDecisions).where(and(
    eq(issueExecutionDecisions.id, input.decisionId),
    eq(issueExecutionDecisions.companyId, input.companyId),
    eq(issueExecutionDecisions.issueId, input.issueId),
  )).limit(1);
  return isCurrentQaChangesRequestedDecision({ ...input, issue: issue ?? null, decision: decision ?? null });
}
