import { createHash } from "node:crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { heartbeatRunEvents, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { ExecutionProjection } from "@paperclipai/shared";

const LIMIT = 20;
const cleanupFamily = sql`left(entry.value->>'kind', 15) = 'native_cleanup_'`;
// Keep filesystem names, provider homes, credentials and arbitrary history out
// of this read model. These are the original cleanup producer's scalar fields.
export const nativeCleanupHistoryReadback = sql<unknown>`case
  when jsonb_typeof(${nativeRunFinalizations.recoveryHistory}) = 'array' then coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind', entry.value->>'kind', 'phase', entry.value->>'phase',
      'requestId', entry.value->>'requestId', 'sourceFingerprint', entry.value->>'sourceFingerprint',
      'settledFingerprint', entry.value->>'settledFingerprint', 'code', entry.value->>'code',
      'runId', entry.value->>'runId', 'nativeSessionId', entry.value->>'nativeSessionId',
      'runnerInstanceId', entry.value->>'runnerInstanceId',
      'startedAt', entry.value->>'startedAt', 'settledAt', entry.value->>'settledAt') order by entry.ordinality desc)
    from (select value, ordinality from jsonb_array_elements(${nativeRunFinalizations.recoveryHistory})
      with ordinality entry(value, ordinality) where ${cleanupFamily} order by ordinality desc limit ${LIMIT + 1}) entry
  ), '[]'::jsonb) else null end`;
export const nativeCleanupHistoryCount = sql<number | null>`case
  when jsonb_typeof(${nativeRunFinalizations.recoveryHistory}) = 'array' then (
    select count(*)::integer from jsonb_array_elements(${nativeRunFinalizations.recoveryHistory})
      with ordinality entry(value, ordinality) where ${cleanupFamily}
  ) else null end`;

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
  ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256 ? v : null;
const code = (v: unknown) => typeof v === "string" && /^[a-z0-9_.:-]{1,160}$/i.test(v) ? v : null;
const sha = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/i.test(v) ? v.toLowerCase() : null;
const hash = (v: unknown) => text(v) === null ? null : createHash("sha256").update(v as string, "utf8").digest("hex");
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const at = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const kinds = new Set(["native_cleanup_maintenance", "native_cleanup_source_archive", "native_cleanup_runner_epoch"]);

export type NativeRunRecoveryProjection = { runId: string; projection: ExecutionProjection | null };

/** Inspection only. This never invokes cleanup, probes a process or grants retry. */
export async function readNativeRunRecoveryReadback(
  db: Pick<Db, "select">,
  run: { id: string; companyId: string; agentId: string; nativeIssueId: string;
    nativeSessionId: string | null; runnerInstanceId: string | null },
  cleanup: { finalizationObserved: boolean; history: unknown; totalCount: unknown },
  execution?: NativeRunRecoveryProjection,
) {
  const events = await db.select({
    eventSeq: heartbeatRunEvents.seq, createdAt: heartbeatRunEvents.createdAt,
    receipt: sql<unknown>`jsonb_build_object(
      'schema', ${heartbeatRunEvents.payload}->'nativeCleanupEvent'->>'schema',
      'requestId', ${heartbeatRunEvents.payload}->'nativeCleanupEvent'->>'requestId',
      'rawSourceInstanceId', ${heartbeatRunEvents.payload}->'nativeCleanupEvent'->>'rawSourceInstanceId',
      'rawSourceSeq', ${heartbeatRunEvents.payload}->'nativeCleanupEvent'->'rawSourceSeq',
      'rawEventType', ${heartbeatRunEvents.payload}->'nativeCleanupEvent'->>'rawEventType',
      'rawCanonicalSha256', ${heartbeatRunEvents.payload}->'nativeCleanupEvent'->>'rawCanonicalSha256')`,
  }).from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, run.companyId),
    eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.agentId, run.agentId),
    eq(heartbeatRunEvents.eventType, "native.cleanup.event")))
    .orderBy(desc(heartbeatRunEvents.seq)).limit(LIMIT + 1);
  const actions = await db.select({
    id: issueRecoveryActions.id, kind: issueRecoveryActions.kind, status: issueRecoveryActions.status,
    cause: issueRecoveryActions.cause, ownerType: issueRecoveryActions.ownerType,
    ownerAgentId: issueRecoveryActions.ownerAgentId, returnOwnerAgentId: issueRecoveryActions.returnOwnerAgentId,
    outcome: issueRecoveryActions.outcome, attemptCount: issueRecoveryActions.attemptCount,
    maxAttempts: issueRecoveryActions.maxAttempts, timeoutAt: issueRecoveryActions.timeoutAt,
    updatedAt: issueRecoveryActions.updatedAt,
    evidence: sql<unknown>`jsonb_build_object(
      'runId', ${issueRecoveryActions.evidence}->>'runId',
      'sourceRunId', ${issueRecoveryActions.evidence}->>'sourceRunId',
      'policy', ${issueRecoveryActions.evidence}->'automaticRecovery'->>'policy',
      'actionOutcome', ${issueRecoveryActions.evidence}->'automaticRecovery'->>'actionOutcome',
      'replay', ${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay',
      'reconciledRunId', ${issueRecoveryActions.evidence}->'executionReconciliation'->>'runId',
      'providerStopped', ${issueRecoveryActions.evidence}->'executionReconciliation'->'providerStopped')`,
  }).from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, run.companyId),
    eq(issueRecoveryActions.sourceIssueId, run.nativeIssueId), or(
      sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
      sql`${issueRecoveryActions.evidence}->>'sourceRunId' = ${run.id}`)))
    .orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id)).limit(LIMIT + 1);

  const history = Array.isArray(cleanup.history) ? cleanup.history : [];
  const historyRows = history.slice(0, LIMIT).map(value => {
    const v = record(value);
    const mismatched = (v.runId != null && v.runId !== run.id)
      || (v.nativeSessionId != null && v.nativeSessionId !== run.nativeSessionId)
      || (v.runnerInstanceId != null && v.runnerInstanceId !== run.runnerInstanceId);
    const bindingState = mismatched ? "conflicting" : v.runId === run.id
      && v.nativeSessionId === run.nativeSessionId && v.runnerInstanceId === run.runnerInstanceId ? "exact" : "row_scoped";
    return { kind: code(v.kind), phase: code(v.phase), requestIdHash: hash(v.requestId),
      sourceFingerprint: sha(v.sourceFingerprint), settledFingerprint: sha(v.settledFingerprint),
      code: code(v.code), startedAt: at(v.startedAt), settledAt: at(v.settledAt), bindingState };
  });
  const historyUnclassified = historyRows.filter(v => !v.kind || !kinds.has(v.kind)
    || !v.requestIdHash || v.bindingState === "conflicting").length;
  const total = cleanup.finalizationObserved ? count(cleanup.totalCount) : null;
  const historyComplete = total !== null && total <= LIMIT && history.length === total;
  const historyState = !cleanup.finalizationObserved || !Array.isArray(cleanup.history)
    || !historyComplete || historyUnclassified ? "unverified" : total === 0 ? "not_recorded" : "recorded";
  const eventRows = events.slice(0, LIMIT).map(row => {
    const v = record(row.receipt);
    const valid = v.schema === "paperclip.native_cleanup_event.v1" && count(v.rawSourceSeq) !== null
      && sha(v.rawCanonicalSha256) !== null && hash(v.requestId) !== null && code(v.rawEventType) !== null;
    return { eventSeq: row.eventSeq, createdAt: row.createdAt, rawSourceSeq: count(v.rawSourceSeq),
      eventType: code(v.rawEventType), requestIdHash: hash(v.requestId), canonicalSha256: sha(v.rawCanonicalSha256),
      bindingState: v.rawSourceInstanceId !== run.runnerInstanceId ? "conflicting" : valid ? "same_run" : "unverified" };
  });
  const eventUnclassified = eventRows.filter(v => v.bindingState !== "same_run").length;
  const actionRows = actions.slice(0, LIMIT).map(row => {
    const v = record(row.evidence);
    const matches = v.runId === run.id || v.sourceRunId === run.id;
    return { id: row.id, kind: code(row.kind), status: code(row.status), cause: code(row.cause),
      ownerType: code(row.ownerType), ownerAgentId: row.ownerAgentId, returnOwnerAgentId: row.returnOwnerAgentId,
      outcome: code(row.outcome), attemptCount: row.attemptCount, maxAttempts: row.maxAttempts,
      timeoutAt: row.timeoutAt, updatedAt: row.updatedAt, automaticRecoveryPolicy: code(v.policy),
      automaticActionOutcome: code(v.actionOutcome), replay: code(v.replay),
      providerStoppedRecorded: v.reconciledRunId === run.id && typeof v.providerStopped === "boolean" ? v.providerStopped : null,
      entry: matches ? `/api/issues/${run.nativeIssueId}/recovery-actions?actionId=${row.id}` : null,
      classified: matches };
  });
  const actionUnclassified = actionRows.filter(v => !v.classified).length;
  const projection = execution?.runId === run.id ? execution.projection : null;
  const gaps: string[] = [];
  if (!projection) gaps.push("execution_projection_unverified");
  if (historyState === "unverified") gaps.push("cleanup_history_unverified");
  else if (historyState === "not_recorded") gaps.push("cleanup_history_not_recorded");
  if (events.length === 0) gaps.push("maintenance_event_not_recorded");
  if (eventUnclassified || events.length > LIMIT) gaps.push("maintenance_event_unverified");
  if (actions.length === 0) gaps.push("same_run_recovery_action_not_recorded");
  if (actionUnclassified || actions.length > LIMIT) gaps.push("same_run_recovery_action_unverified");
  gaps.push("provider_stop_not_evaluated", "action_outcomes_not_evaluated", "source_run_link_unverified");
  return {
    schema: "paperclip.native-run-recovery-readback.v1" as const, inspectionOnly: true,
    projection: { state: projection ? "observed" : "unverified", phase: code(projection?.phase),
      cause: code(projection?.cause), recoveryOwner: code(projection?.recoveryOwner),
      nextAction: text(projection?.nextAction), successorRunId: text(projection?.successorRunId),
      inspectionActions: projection?.permittedActions.filter(v => v === "inspect_run" || v === "inspect_recovery") ?? [] },
    cleanupHistory: { state: historyState, complete: historyComplete, totalCount: total,
      observedCount: historyRows.length, unclassifiedCount: historyUnclassified, rows: historyRows },
    maintenanceEvents: { state: events.length > LIMIT || eventUnclassified ? "unverified"
      : events.length ? "recorded" : "not_recorded", complete: events.length <= LIMIT,
      observedCount: eventRows.length, unclassifiedCount: eventUnclassified, rows: eventRows },
    actions: { state: actions.length > LIMIT || actionUnclassified ? "unverified"
      : actions.length ? "recorded" : "not_recorded", complete: actions.length <= LIMIT,
      observedCount: actionRows.length, unclassifiedCount: actionUnclassified,
      rows: actionRows.map(({ classified: _classified, ...row }) => row) },
    gaps,
    verification: { providerStop: "unverified", actionOutcomes: "unverified",
      sourceRunLink: "unverified", sourceRunId: null, automaticRetry: false },
    operatorEntry: { kind: "inspect_original_run_and_task_recovery",
      runPath: `/agents/${run.agentId}/runs/${run.id}`, taskPath: `/issues/${run.nativeIssueId}` },
  };
}
