import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  environmentLeases, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunResults, statusDecisionEffects, statusDecisions, type Db,
} from "@paperclipai/db";
import { badRequest, conflict } from "../../errors.js";
import { nativeCleanupHistoryReadback, nativeCleanupHistoryCount, readNativeRunRecoveryReadback, type NativeRunRecoveryProjection } from "./native-run-recovery-readback.js";

const RESULT_LIMIT = 20;
const EFFECT_LIMIT = 50;
const LEASE_LIMIT = 20;
const digest = (value: string | null) => value === null ? null
  : createHash("sha256").update(value, "utf8").digest("hex");
const canonicalDigest = (value: string | null) => {
  if (value === null) return null;
  const match = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
};

export function parseNativeRunReceiptReadbackQuery(query: Record<string, unknown>) {
  if (query.receiptReadback === undefined && query.receiptCanonicalSha256 === undefined) return null;
  if (query.receiptReadback !== "1" ||
    (query.receiptCanonicalSha256 !== undefined &&
      (typeof query.receiptCanonicalSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(query.receiptCanonicalSha256)))) {
    throw badRequest("Invalid native run receipt readback query");
  }
  return { expectedCanonicalSha256: typeof query.receiptCanonicalSha256 === "string"
    ? query.receiptCanonicalSha256.toLowerCase() : null };
}

/** The route must first authorize the authenticated company's active owner. */
export async function readNativeRunReceiptReadback(
  db: Db,
  binding: { id: string; companyId: string; agentId: string; nativeIssueId: string | null },
  expectedCanonicalSha256: string | null,
  execution?: NativeRunRecoveryProjection,
) {
  // A readback is a snapshot, never a lease claim, repair, or finalizer call.
  return db.transaction(async (tx) => {
    const run = await tx.select({
      id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      nativeIssueId: heartbeatRuns.nativeIssueId, completionContractId: heartbeatRuns.completionContractId, status: heartbeatRuns.status,
      runtimeMode: heartbeatRuns.runtimeMode, runnerInstanceId: heartbeatRuns.runnerInstanceId,
      nativeSessionId: heartbeatRuns.nativeSessionId, controllerBootId: heartbeatRuns.controllerBootId,
      controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
      processPid: heartbeatRuns.processPid, processStartedAt: heartbeatRuns.processStartedAt,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.id), eq(heartbeatRuns.companyId, binding.companyId)))
      .limit(1).then(rows => rows[0] ?? null);
    if (!run || run.agentId !== binding.agentId || run.nativeIssueId !== binding.nativeIssueId) {
      throw conflict("Heartbeat run binding changed during receipt readback");
    }
    if (run.runtimeMode !== "native" || !run.nativeIssueId) {
      throw conflict("Native run receipt readback is unavailable for this run");
    }
    const scope = { companyId: run.companyId, issueId: run.nativeIssueId, runId: run.id, agentId: run.agentId };
    const native = run.runtimeMode === "native" && run.nativeIssueId !== null;
    const resultRows = native ? await tx.select({
      id: nativeRunResults.id, turnId: nativeRunResults.turnId,
      completionContractId: nativeRunResults.completionContractId, schemaStatus: nativeRunResults.schemaStatus,
      canonicalSha256: nativeRunResults.canonicalSha256, serverFingerprint: nativeRunResults.serverFingerprint,
      callerResultId: nativeRunResults.callerResultId, callerDedupeKey: nativeRunResults.callerDedupeKey,
      createdAt: nativeRunResults.createdAt,
    }).from(nativeRunResults).where(and(eq(nativeRunResults.companyId, run.companyId),
      eq(nativeRunResults.issueId, run.nativeIssueId!), eq(nativeRunResults.runId, run.id)))
      .orderBy(desc(nativeRunResults.createdAt), asc(nativeRunResults.id)).limit(RESULT_LIMIT + 1) : [];
    const finalization = native ? await tx.select({
      phase: nativeRunFinalizations.phase, attempt: nativeRunFinalizations.attempt,
      resultId: nativeRunFinalizations.resultId, assessmentId: nativeRunFinalizations.assessmentId,
      decisionId: nativeRunFinalizations.decisionId, failureCode: nativeRunFinalizations.failureCode,
      leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
      controllerBootId: nativeRunFinalizations.controllerBootId, controllerPid: nativeRunFinalizations.controllerPid,
      controllerProcessStartedAt: nativeRunFinalizations.controllerProcessStartedAt,
      controllerGeneration: nativeRunFinalizations.controllerGeneration,
      recoveryState: nativeRunFinalizations.recoveryState, recoveryRequestId: nativeRunFinalizations.recoveryRequestId,
      controlDeadlineAt: nativeRunFinalizations.controlDeadlineAt, nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
      updatedAt: nativeRunFinalizations.updatedAt,
      cleanupHistory: nativeCleanupHistoryReadback, cleanupHistoryCount: nativeCleanupHistoryCount,
    }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, run.companyId),
      eq(nativeRunFinalizations.issueId, run.nativeIssueId!), eq(nativeRunFinalizations.runId, run.id)))
      .limit(1).then(rows => rows[0] ?? null) : null;
    const decision = finalization?.decisionId ? await tx.select({
      id: statusDecisions.id, assessmentId: statusDecisions.assessmentId,
      decisionVersion: statusDecisions.decisionVersion, policyVersion: statusDecisions.policyVersion,
      fromStatus: statusDecisions.fromStatus, toStatus: statusDecisions.toStatus, reasonCode: statusDecisions.reasonCode,
      decisionDigest: statusDecisions.decisionDigest, applicationState: statusDecisions.applicationState,
      appliedAt: statusDecisions.appliedAt, createdAt: statusDecisions.createdAt,
    }).from(statusDecisions).where(and(eq(statusDecisions.companyId, run.companyId),
      eq(statusDecisions.issueId, run.nativeIssueId!), eq(statusDecisions.runId, run.id),
      eq(statusDecisions.id, finalization.decisionId)))
      .limit(1).then(rows => rows[0] ?? null) : null;
    const effectRows = decision ? await tx.select({
      id: statusDecisionEffects.id, decisionId: statusDecisionEffects.decisionId,
      ordinal: statusDecisionEffects.ordinal, effectKind: statusDecisionEffects.effectKind,
      targetType: statusDecisionEffects.targetType, targetId: statusDecisionEffects.targetId,
      idempotencyKey: statusDecisionEffects.idempotencyKey, deliveryState: statusDecisionEffects.deliveryState,
      attemptCount: statusDecisionEffects.attemptCount, nextAttemptAt: statusDecisionEffects.nextAttemptAt,
      deliveredAt: statusDecisionEffects.deliveredAt, updatedAt: statusDecisionEffects.updatedAt,
    }).from(statusDecisionEffects).where(and(eq(statusDecisionEffects.companyId, run.companyId),
      eq(statusDecisionEffects.issueId, run.nativeIssueId!), eq(statusDecisionEffects.decisionId, decision.id)))
      .orderBy(asc(statusDecisionEffects.ordinal), asc(statusDecisionEffects.id)).limit(EFFECT_LIMIT + 1) : [];
    const issue = run.nativeIssueId ? await tx.select({
      id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
      checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId,
      lastStatusDecisionId: issues.lastStatusDecisionId,
    }).from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, run.nativeIssueId)))
      .limit(1).then(rows => rows[0] ?? null) : null;
    const leaseRows = await tx.select({
      id: environmentLeases.id, environmentId: environmentLeases.environmentId,
      executionWorkspaceId: environmentLeases.executionWorkspaceId, status: environmentLeases.status,
      leasePolicy: environmentLeases.leasePolicy, acquiredAt: environmentLeases.acquiredAt,
      expiresAt: environmentLeases.expiresAt, releasedAt: environmentLeases.releasedAt,
      cleanupStatus: environmentLeases.cleanupStatus,
    }).from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId),
      eq(environmentLeases.heartbeatRunId, run.id)))
      .orderBy(desc(environmentLeases.acquiredAt), asc(environmentLeases.id)).limit(LEASE_LIMIT + 1);

    const complete = resultRows.length <= RESULT_LIMIT;
    const visibleResults = resultRows.slice(0, RESULT_LIMIT);
    const accepted = visibleResults.filter(row => row.schemaStatus === "accepted");
    const hashes = accepted.map(row => canonicalDigest(row.canonicalSha256));
    const reasons: string[] = [];
    let state: "accepted_same_hash" | "missing" | "unverified" | "conflicting" = "unverified";
    if (!native) reasons.push("not_native_run");
    else if (resultRows.length === 0) {
      state = expectedCanonicalSha256 ? "missing" : "unverified";
      if (!expectedCanonicalSha256) reasons.push("expected_hash_not_supplied");
      reasons.push("no_result_row_observed");
    } else {
      if (!expectedCanonicalSha256) reasons.push("expected_hash_not_supplied");
      if (!complete) reasons.push("result_row_limit");
      if (accepted.length === 0) reasons.push("no_accepted_result_observed");
      if (hashes.includes(null)) reasons.push("stored_hash_unverified");
      const fingerprintUnverified = accepted.some(row => canonicalDigest(row.serverFingerprint) === null);
      if (fingerprintUnverified) reasons.push("stored_fingerprint_unverified");
      if (!finalization) reasons.push("finalization_not_observed");
      else if (!finalization.resultId) reasons.push("finalization_result_not_referenced");
      const referenced = finalization?.resultId ? visibleResults.find(row => row.id === finalization.resultId) : null;
      const referenceMissing = finalization?.resultId && !referenced && complete;
      const decisionConflict = finalization?.decisionId && (!decision || decision.assessmentId !== finalization.assessmentId);
      if (referenceMissing) reasons.push("result_reference_conflict");
      if (decisionConflict) reasons.push("decision_reference_conflict");
      if ((expectedCanonicalSha256 && hashes.some(hash => hash !== null && hash !== expectedCanonicalSha256)) ||
        new Set(hashes.filter(hash => hash !== null)).size > 1 || referenceMissing || decisionConflict ||
        accepted.some(row => row.completionContractId !== run.completionContractId) ||
        (referenced && referenced.schemaStatus !== "accepted")) {
        state = "conflicting";
        reasons.push("observed_receipt_conflict");
      } else if (expectedCanonicalSha256 && complete && accepted.length > 0 && !hashes.includes(null) &&
        !fingerprintUnverified && finalization?.resultId) {
        state = "accepted_same_hash";
      }
    }
    const { leaseOwner, recoveryRequestId, cleanupHistory, cleanupHistoryCount, ...safeFinalization } = finalization
      ?? { leaseOwner: null, recoveryRequestId: null, cleanupHistory: null, cleanupHistoryCount: null };
    const recovery = await readNativeRunRecoveryReadback(tx, { ...run, nativeIssueId: scope.issueId },
      { finalizationObserved: finalization !== null, history: cleanupHistory, totalCount: cleanupHistoryCount }, execution);
    return {
      schema: "paperclip.native-run-receipt-readback.v1" as const,
      observedAtUTC: new Date().toISOString(), scope, recovery,
      comparison: { state, expectedCanonicalSha256, reasons, complete },
      results: { complete, limit: RESULT_LIMIT, rows: visibleResults.map(({ turnId, callerResultId, callerDedupeKey, ...row }) => ({
        ...row, canonicalSha256: canonicalDigest(row.canonicalSha256), serverFingerprint: canonicalDigest(row.serverFingerprint),
        turnIdHash: digest(turnId), callerResultIdHash: digest(callerResultId), callerDedupeKeyHash: digest(callerDedupeKey),
      })) },
      finalization: { state: finalization ? "found" : "missing", record: finalization ? {
        ...safeFinalization, leaseOwnerHash: digest(leaseOwner), recoveryRequestIdHash: digest(recoveryRequestId),
      } : null },
      decision: { state: finalization?.decisionId ? decision ? "found" : "missing" : "not_referenced",
        record: decision ? { ...decision, decisionDigest: canonicalDigest(decision.decisionDigest) } : null },
      effects: { state: decision ? effectRows.length ? "found" : "missing"
        : finalization?.decisionId ? "unverified" : "not_referenced",
        complete: !finalization?.decisionId || (decision !== null && effectRows.length <= EFFECT_LIMIT), limit: EFFECT_LIMIT,
        rows: effectRows.slice(0, EFFECT_LIMIT).map(({ targetId, idempotencyKey, ...row }) => ({
          ...row, targetIdHash: digest(targetId), idempotencyKeyHash: digest(idempotencyKey),
        })) },
      authority: {
        run: { status: run.status, runtimeMode: run.runtimeMode, runnerInstanceId: run.runnerInstanceId,
          nativeSessionId: run.nativeSessionId, controllerBootId: run.controllerBootId,
          controllerLeaseExpiresAt: run.controllerLeaseExpiresAt, processPid: run.processPid, processStartedAt: run.processStartedAt },
        issue,
        environmentLeases: { complete: leaseRows.length <= LEASE_LIMIT, limit: LEASE_LIMIT, rows: leaseRows.slice(0, LEASE_LIMIT) },
      },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
