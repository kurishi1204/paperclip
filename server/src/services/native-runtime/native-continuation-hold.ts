import { environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { and, asc, eq, notInArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { isCancelledNativeStartup } from "../cancelled-native-startup.js";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext } from "./native-review-participant.js";

export type NativeContinuationIssueFacts = Pick<typeof issues.$inferSelect,
  "id" | "companyId" | "status" | "assigneeAgentId" | "assigneeUserId" |
  "executionRunId" | "checkoutRunId">;
export type NativeContinuationRunFacts = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "nativeIssueId" | "runtimeMode" | "status" | "contextSnapshot">;
export type NativeContinuationFinalizationFacts = Pick<typeof nativeRunFinalizations.$inferSelect,
  "runId" | "companyId" | "issueId" | "phase" | "resultId" | "recoveryState" |
  "leaseOwner" | "failureDetail">;
export type NativeContinuationAuthorityFacts = {
  issue: NativeContinuationIssueFacts;
  run: NativeContinuationRunFacts | null | undefined;
  reviewAssignmentValid?: boolean;
};
export type NativeContinuationHoldFacts = {
  issue: NativeContinuationIssueFacts;
  run: NativeContinuationRunFacts | null | undefined;
  finalization: NativeContinuationFinalizationFacts | null | undefined;
};
/** Works with the existing Db and its transaction handle without adding
 * transaction/write capabilities to this read-only helper's public contract. */
export type NativeContinuationReader = Pick<Db, "select">;

function hasNativeContinuationBinding(input: NativeContinuationHoldFacts | NativeContinuationAuthorityFacts): boolean {
  const { issue, run } = input;
  return Boolean(run && run.runtimeMode === "native" && run.companyId === issue.companyId
    && run.nativeIssueId === issue.id && issue.status !== "done" && issue.status !== "cancelled"
    && issue.executionRunId === run.id
    && (issue.checkoutRunId === null || issue.checkoutRunId === run.id));
}

/** Current dispatch authority, not the retention predicate. In particular,
 * running/failed, phase, lease, due time and process gates belong to the claim. */
export function hasNativeContinuationIssueAuthority(input: NativeContinuationAuthorityFacts): boolean {
  const { issue, run } = input;
  if (!hasNativeContinuationBinding(input) || !run || issue.assigneeUserId !== null) return false;
  if (issue.assigneeAgentId === run.agentId) return true;
  return input.reviewAssignmentValid === true
    && readNativeReviewAssignmentContext(run.contextSnapshot) !== null;
}

// Matches coalesce(jsonb ->> key, '') = '' in the assignee SQL fence. JS
// truthiness would incorrectly accept JSON false/0, which PostgreSQL rejects.
function emptyFailureMarker(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Retain an exact existing result-less continuation binding independently of
 * current dispatch authority. Agent pause/resume and reviewer audience changes
 * must not turn an automatic clear into a competing run. Explicit revocation
 * still clears the binding; terminal issue status also ends this hold. */
export function isNativeContinuationHeld(input: NativeContinuationHoldFacts): boolean {
  const { issue, run, finalization } = input;
  return hasNativeContinuationBinding(input) && run?.status === "failed"
    && finalization !== null && finalization !== undefined
    && finalization.runId === run.id && finalization.companyId === issue.companyId
    && finalization.issueId === issue.id && finalization.phase === "retryable_failure"
    && finalization.resultId === null && finalization.recoveryState === "resuming_session"
    && finalization.leaseOwner === null
    && emptyFailureMarker(finalization.failureDetail?.successorRunId)
    && emptyFailureMarker(finalization.failureDetail?.replacementDenied);
}

/** Plain reads only. The existing reviewer helper deliberately receives no
 * actingRunId: its running-only acting-run contract is not a failed-run hold.
 * A caller that needs stability must already hold the issue lock and establish
 * that review-authority transitions take the same lock; this helper adds none. */
export async function readNativeContinuationIssueAuthority(
  db: NativeContinuationReader,
  input: { issue: NativeContinuationIssueFacts; run: NativeContinuationRunFacts | null | undefined },
): Promise<boolean> {
  if (hasNativeContinuationIssueAuthority(input)) return true;
  const { issue, run } = input;
  if (!run || !hasNativeContinuationIssueAuthority({ ...input, reviewAssignmentValid: true })) return false;
  // The complete existing assignment helper and its invokability dependency
  // use select only. Keep their wider historical Db type at this one boundary,
  // rather than requiring callers to cast each transaction or widening scope.
  const reviewAssignment = await getNativeReviewAssignment(db as Db, {
    companyId: issue.companyId,
    issueId: issue.id,
    agentId: run.agentId,
    contextSnapshot: run.contextSnapshot,
  });
  return hasNativeContinuationIssueAuthority({ ...input, reviewAssignmentValid: reviewAssignment !== null });
}

/** Plain R/F reads only. No reviewer/invokability lookup: retention cannot
 * depend on a dispatch permission that changes without locking the issue. */
export async function readNativeContinuationHold(
  db: NativeContinuationReader,
  input: { issue: NativeContinuationIssueFacts; runId: string },
): Promise<boolean> {
  const { issue, runId } = input;
  if (issue.executionRunId !== runId) return false;
  const run = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, issue.companyId),
    eq(heartbeatRuns.nativeIssueId, issue.id),
  )).limit(1).then(rows => rows[0] ?? null);
  if (!run || run.status !== "failed") return false;
  const finalization = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.runId, runId), eq(nativeRunFinalizations.companyId, issue.companyId),
    eq(nativeRunFinalizations.issueId, issue.id),
  )).limit(1).then(rows => rows[0] ?? null);
  return isNativeContinuationHeld({ issue, run, finalization });
}

/** Complete retention predicate, correlated to current issues binding. It is
 * deliberately independent of dispatch authority for assignees and reviewers.
 * NOT H alone is not permission to clear: the writer must atomically recheck
 * its existing clearability condition too. No F/R locks are added here. */
export function nativeContinuationHoldSql(): SQL<boolean> {
  // Drizzle dequalifies Column chunks in SELECT projections. Keep the outer
  // relation explicit even there, rather than accidentally binding an inner
  // run/F column (or producing an ambiguous company_id).
  const outer = (name: string) => sql`${issues}.${sql.identifier(name)}`;
  return sql<boolean>`exists (
    select 1 from ${heartbeatRuns} as continuation_run
    inner join ${nativeRunFinalizations} as continuation_finalization
      on continuation_finalization.run_id = continuation_run.id
      and continuation_finalization.company_id = continuation_run.company_id
      and continuation_finalization.issue_id = continuation_run.native_issue_id
    where continuation_run.id = ${outer("execution_run_id")}
      and continuation_run.company_id = ${outer("company_id")}
      and continuation_run.native_issue_id = ${outer("id")}
      and continuation_run.runtime_mode = 'native'
      and continuation_run.status = 'failed'
      and ${outer("status")} not in ('done', 'cancelled')
      and (${outer("checkout_run_id")} is null or ${outer("checkout_run_id")} = continuation_run.id)
      and continuation_finalization.phase = 'retryable_failure'
      and continuation_finalization.result_id is null
      and continuation_finalization.recovery_state = 'resuming_session'
      and continuation_finalization.lease_owner is null
      and coalesce(continuation_finalization.failure_detail ->> 'successorRunId', '') = ''
      and coalesce(continuation_finalization.failure_detail ->> 'replacementDenied', '') = ''
  )`;
}

function recoveryColumn(relation: SQLWrapper, name: string): SQL {
  return sql`${relation}.${sql.identifier(name)}`;
}

function nativeBoardEvidenceWaitingSql(finalization: SQLWrapper): SQL<boolean> {
  const f = (name: string) => recoveryColumn(finalization, name);
  return sql<boolean>`coalesce((${f("phase")} = 'terminal_failure'
    and ${f("failure_detail")}->'recoveryOwner'->>'kind' = 'board'), false)`;
}

/** This is an unresolved native settlement/evidence path, not permission to
 * resume a provider or replay an old effect. A terminal coordinator can still
 * explicitly retain board-owned ambiguous evidence. The original failure's
 * arbitrary error code need not belong to the separate reconciliation enum.
 * Use this one row predicate for the collector and source UPDATE fence. */
function nativeContinuationRecoveryRowSql(run: SQLWrapper, finalization: SQLWrapper): SQL<boolean> {
  const r = (name: string) => recoveryColumn(run, name);
  const f = (name: string) => recoveryColumn(finalization, name);
  const action = sql.identifier("native_handoff_action");
  const a = (name: string) => recoveryColumn(action, name);
  const evidence = a("evidence");
  const receiptString = (receipt: string, key: string) => sql<boolean>`
    jsonb_typeof(${evidence}->${receipt}->${key}) = 'string'
    and coalesce(${evidence}->${receipt}->>${key}, '') <> ''`;
  const authorizedHandoff = sql<boolean>`exists (
    select 1 from ${issueRecoveryActions} as native_handoff_action
    where ${a("company_id")} = ${f("company_id")}
      and ${a("source_issue_id")} = ${f("issue_id")}
      and ${a("status")} = 'resolved'
      and (
        (${f("failure_detail")}->>'replacementDenied' = 'operator_reconciled'
          and ${evidence}->'executionReconciliation'->>'runId' = ${r("id")}::text
          and ${receiptString("executionReconciliation", "actorId")}
          and ${receiptString("executionReconciliation", "recordedAt")})
        or
        (${f("failure_detail")}->>'replacementDenied' = 'explicit_user_continuation'
          and ${receiptString("explicitUserContinuation", "actorId")}
          and ${receiptString("explicitUserContinuation", "recordedAt")}
          and ${receiptString("explicitUserContinuation", "runId")}
          and (
            ${evidence}->>'runId' = ${r("id")}::text
            or ${evidence}->>'sourceRunId' = ${r("id")}::text
            or ${evidence}->'explicitUserContinuation'->>'previousRunId' = ${r("id")}::text
          ))
      )
  )`;
  // Unknown nonterminal phases, leases and lost bindings are not settlement.
  // In particular, NOT H and an arbitrary replacementDenied marker cannot
  // release this path. Valid retry receipts may have a null commentId.
  return sql<boolean>`${r("runtime_mode")} = 'native'
    and ${f("result_id")} is null
    and (
      ${f("phase")} not in ('committed', 'applied', 'terminal_failure')
      or ${nativeBoardEvidenceWaitingSql(finalization)}
    )
    and not (${authorizedHandoff})`;
}

function nativeContinuationOrphanSql(run: SQLWrapper): SQL<boolean> {
  const i = (name: string) => recoveryColumn(sql`${issues}`, name);
  const runId = recoveryColumn(run, "id");
  return sql<boolean>`(${i("execution_run_id")} is distinct from ${runId}
    or (${i("checkout_run_id")} is not null and ${i("checkout_run_id")} <> ${runId}))`;
}

export function nativeContinuationRecoveryPathSql(
  input: { agentId?: string | null; orphanedOnly?: boolean;
    /** Internal, transaction-local proof IDs only. The source writer must
     * obtain these under its issue lock with lockCancelledStartupRecoveryExemptions. */
    provenCancelledStartupRunIds?: readonly string[] } = {},
): SQL<boolean> {
  const run = sql.identifier("native_recovery_run");
  const finalization = sql.identifier("native_recovery_finalization");
  const i = (name: string) => recoveryColumn(sql`${issues}`, name);
  const r = (name: string) => recoveryColumn(run, name);
  const f = (name: string) => recoveryColumn(finalization, name);
  return sql<boolean>`exists (
    select 1 from ${heartbeatRuns} as native_recovery_run
    inner join ${nativeRunFinalizations} as native_recovery_finalization
      on ${f("run_id")} = ${r("id")}
      and ${f("company_id")} = ${r("company_id")}
      and ${f("issue_id")} = ${r("native_issue_id")}
    where ${r("company_id")} = ${i("company_id")}
      and ${r("native_issue_id")} = ${i("id")}
      and ${i("status")} not in ('done', 'cancelled')
      and ${input.agentId ? sql`${r("agent_id")} = ${input.agentId}` : sql`true`}
      and ${input.provenCancelledStartupRunIds?.length
        ? notInArray(r("id"), [...input.provenCancelledStartupRunIds]) : sql`true`}
      and ${nativeContinuationRecoveryRowSql(run, finalization)}
      and ${input.orphanedOnly ? nativeContinuationOrphanSql(run) : sql`true`}
  )`;
}

async function isSameOwnerCancelledStartup(
  db: NativeContinuationReader,
  issue: NativeContinuationIssueFacts,
  run: typeof heartbeatRuns.$inferSelect,
  finalization: typeof nativeRunFinalizations.$inferSelect,
): Promise<boolean> {
  // This only removes an unnecessary evidence hold for the unchanged owner.
  // It neither retries the stopped run nor authorizes a new provider turn.
  // Cross-owner history and explicitly board-owned uncertainty still require
  // the existing reconciliation decision, even when attempt is zero.
  const owner = finalization.failureDetail?.recoveryOwner;
  if (issue.assigneeUserId !== null || issue.assigneeAgentId !== run.agentId
    || (owner && typeof owner === "object" && "kind" in owner && owner.kind === "board")) return false;
  return isCancelledNativeStartup(db as Db, run, finalization);
}

/** The caller already holds I. Reprove the one existing complete cancellation
 * receipt under F then R and existing lease locks; a busy row stays protected by the SQL fence.
 * SKIP LOCKED avoids waiting on a coordinator that may need the issue lock.
 * Do not persist or carry these IDs into a later transaction. */
export async function lockCancelledStartupRecoveryExemptions(
  db: NativeContinuationReader,
  issue: NativeContinuationIssueFacts,
): Promise<string[]> {
  if (!issue.assigneeAgentId || issue.assigneeUserId !== null) return [];
  const candidates = await db.select({ runId: heartbeatRuns.id }).from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, and(
      eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
      eq(nativeRunFinalizations.issueId, heartbeatRuns.nativeIssueId),
    )).where(and(
      eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.nativeIssueId, issue.id),
      eq(heartbeatRuns.agentId, issue.assigneeAgentId), eq(heartbeatRuns.status, "cancelled"),
      nativeContinuationRecoveryRowSql(sql`${heartbeatRuns}`, sql`${nativeRunFinalizations}`),
    )).orderBy(asc(heartbeatRuns.id));
  const proven: string[] = [];
  for (const { runId } of candidates) {
    const [finalization] = await db.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, issue.companyId),
      eq(nativeRunFinalizations.issueId, issue.id), eq(nativeRunFinalizations.runId, runId),
    )).for("update", { skipLocked: true });
    if (!finalization) continue;
    const [run] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.nativeIssueId, issue.id),
      eq(heartbeatRuns.id, runId),
    )).for("update", { skipLocked: true });
    if (!run) continue;
    const leaseScope = and(eq(environmentLeases.companyId, issue.companyId), eq(environmentLeases.heartbeatRunId, runId));
    const lockedLeases = await db.select({ id: environmentLeases.id }).from(environmentLeases)
      .where(leaseScope).for("update", { skipLocked: true });
    const allLeases = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(leaseScope);
    const lockedIds = new Set(lockedLeases.map(lease => lease.id));
    // Lease updates need not lock F/R. Pin every current row, while the R
    // FOR UPDATE lock also fences new FK-referencing leases/events.
    if (lockedIds.size !== allLeases.length || allLeases.some(lease => !lockedIds.has(lease.id))) continue;
    if (await isSameOwnerCancelledStartup(db, issue, run, finalization)) proven.push(runId);
  }
  return proven;
}

/** Advisory reads only. The conservative SQL candidate set is narrowed by the
 * existing complete startup-cancellation proof, never by attempt/PID alone.
 * A source write independently reproves any exemption under I/F/R locks. */
export async function readNativeContinuationRecoveryPath(
  db: NativeContinuationReader,
  input: { companyId: string; issueId: string; agentId?: string | null },
): Promise<{ pending: boolean; orphaned: boolean; orphanedRunIds: string[]; boardEvidenceWaiting: boolean }> {
  const rows = await db.select({
    issue: issues, run: heartbeatRuns, finalization: nativeRunFinalizations,
    runId: heartbeatRuns.id,
    orphaned: nativeContinuationOrphanSql(sql`${heartbeatRuns}`),
    boardEvidenceWaiting: nativeBoardEvidenceWaitingSql(sql`${nativeRunFinalizations}`),
  }).from(issues)
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.companyId, issues.companyId),
      eq(heartbeatRuns.nativeIssueId, issues.id),
    ))
    .innerJoin(nativeRunFinalizations, and(
      eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
      eq(nativeRunFinalizations.issueId, heartbeatRuns.nativeIssueId),
    ))
    .where(and(
      eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
      sql`${issues}.${sql.identifier("status")} not in ('done', 'cancelled')`,
      input.agentId ? eq(heartbeatRuns.agentId, input.agentId) : sql`true`,
      nativeContinuationRecoveryRowSql(sql`${heartbeatRuns}`, sql`${nativeRunFinalizations}`),
    ));
  const pending = [] as typeof rows;
  for (const row of rows) {
    if (!await isSameOwnerCancelledStartup(db, row.issue, row.run, row.finalization)) pending.push(row);
  }
  const orphanedRunIds = pending.filter(row => row.orphaned).map(row => row.runId).sort();
  return { pending: pending.length > 0, orphaned: orphanedRunIds.length > 0, orphanedRunIds,
    boardEvidenceWaiting: pending.some(row => row.boardEvidenceWaiting) };
}
