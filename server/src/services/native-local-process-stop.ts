import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";

export const PROCESS_START_REQUESTED = "native.process_start_requested";
export const PROCESS_IDENTITY_RECORDED = "native.process_identity_recorded";
const LOCAL_PROCESS_STOPPED = "native.local_process_stopped";
type RunnerOptions = NonNullable<Parameters<typeof import("../vendor/paperclip-runner/index.js").createRunnerdCodexTransport>[0]>;
type OwnedExitReceipt = Parameters<NonNullable<RunnerOptions["onOwnedProcessExit"]>>[0];

function absent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Preserve the host's observation before recovery clears the process fields.
 * Call in the same transaction as that compare-and-set. Never inspect remote
 * process IDs in the control-plane host's process table.
 */
export async function recordNativeLocalProcessStop(db: Db, run: typeof heartbeatRuns.$inferSelect,
  ownedExit?: OwnedExitReceipt) {
  if (run.runtimeMode !== "native" || (!run.processPid && !run.processGroupId)) return false;
  if (ownedExit && (ownedExit.identity.runId !== run.id ||
      ownedExit.identity.normalizedSessionId !== run.nativeSessionId ||
      ownedExit.identity.runnerInstanceId !== run.runnerInstanceId ||
      ownedExit.pid !== run.processPid || ownedExit.processGroupId !== run.processGroupId ||
      !run.processStartedAt || Date.parse(ownedExit.startedAt) !== run.processStartedAt.getTime() ||
      !Number.isFinite(Date.parse(ownedExit.observedAt)) ||
      (ownedExit.exitCode === null && ownedExit.signal === null) ||
      (ownedExit.exitCode !== null && (!Number.isSafeInteger(ownedExit.exitCode) || ownedExit.exitCode < 0)) ||
      (ownedExit.signal !== null && (typeof ownedExit.signal !== "string" || !/^SIG[A-Z0-9]+$/.test(ownedExit.signal))) ||
      ![ownedExit.identity.runnerInstanceId, ownedExit.identity.environmentLeaseId, ownedExit.identity.runId,
        ownedExit.identity.normalizedSessionId, ownedExit.identity.turnId, ownedExit.identity.itemId]
        .every(value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)))) return false;
  const leases = await db.select({ provider: environmentLeases.provider })
    .from(environmentLeases)
    .where(and(
      eq(environmentLeases.companyId, run.companyId),
      eq(environmentLeases.heartbeatRunId, run.id),
    ));
  if (leases.some(lease => lease.provider !== "local")) return false;
  if ((run.processPid && !absent(run.processPid)) ||
      (run.processGroupId && !absent(-run.processGroupId))) return false;
  await appendHeartbeatRunEvent(db, {
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    eventType: LOCAL_PROCESS_STOPPED,
    stream: "system",
    level: "info",
    message: "Recovery verified the local process stopped before clearing its identity.",
    payload: { processPid: run.processPid, processGroupId: run.processGroupId,
      ...(ownedExit ? { completionSource: "owned_child_completion", processStartedAt: ownedExit.startedAt,
        companyId: run.companyId, runId: run.id, agentId: run.agentId, issueId: run.nativeIssueId,
        nativeSessionId: run.nativeSessionId, runnerInstanceId: run.runnerInstanceId,
        identity: { runnerInstanceId: ownedExit.identity.runnerInstanceId,
          environmentLeaseId: ownedExit.identity.environmentLeaseId, runId: ownedExit.identity.runId,
          normalizedSessionId: ownedExit.identity.normalizedSessionId, turnId: ownedExit.identity.turnId,
          itemId: ownedExit.identity.itemId },
        exitCode: ownedExit.exitCode, signal: ownedExit.signal, observedAt: ownedExit.observedAt } : {}) },
  });
  return true;
}

/** Only server-authored evidence counts. A later launch invalidates the receipt. */
export async function hasNativeLocalProcessStop(db: Db, companyId: string, runId: string) {
  const [event] = await db.select({ eventType: heartbeatRunEvents.eventType })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      eq(heartbeatRunEvents.runId, runId),
      isNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, LOCAL_PROCESS_STOPPED]),
    ))
    .orderBy(desc(heartbeatRunEvents.seq))
    .limit(1);
  return event?.eventType === LOCAL_PROCESS_STOPPED;
}

/** Pre-receipt native runs can retain an exact suspended session after their
 * mutable process fields were cleared. This is admission evidence for a new
 * user turn only, never permission to replay the old run or infer its outcomes.
 * The caller must hold the run/controller locks and verify local lease cleanup.
 */
export async function hasHistoricalSuspendedNativeSession(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  if (run.runtimeMode !== "native" || run.processPid || run.processGroupId ||
      !run.nativeSessionId || !run.runnerInstanceId || !run.nativeIssueId) return false;
  const [modernProcessEvidence] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    isNull(heartbeatRunEvents.sourceEventId),
    inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, LOCAL_PROCESS_STOPPED]),
  )).limit(1);
  // A newer launch invalidates an old stop receipt. Never bypass that fence
  // with a suspended file that could belong to the earlier process generation.
  if (modernProcessEvidence) return false;
  const checkpoint = run.runnerProfileJson?.sessionCheckpoint as Record<string, unknown> | undefined;
  if (checkpoint?.providerSessionId != null && (typeof checkpoint.providerSessionId !== "string" ||
      !checkpoint.providerSessionId.trim())) return false;
  const { nativeFailedRunRetryStateIsSafe } = await import("./native-runtime/native-session-executor.js");
  return nativeFailedRunRetryStateIsSafe({
    execution: run.runnerProfileJson?.nativeExecutionInput,
    companyId: run.companyId, issueId: run.nativeIssueId, agentId: run.agentId, runId: run.id,
    nativeSessionId: run.nativeSessionId, runnerInstanceId: run.runnerInstanceId,
    processPid: null, processGroupId: null,
    providerSessionId: typeof checkpoint?.sessionId === "string" ? checkpoint.sessionId : null,
    providerBackendSessionId: typeof checkpoint?.providerSessionId === "string" ? checkpoint.providerSessionId : null,
    recoveryMode: "exact_checkpoint_resume", allowVerifiedBackup: false,
  });
}

/** Recover the exact stopped identity after the mutable run fields were cleared. */
export async function readNativeLocalProcessStop(db: Db, companyId: string, runId: string) {
  const [event] = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
      isNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, LOCAL_PROCESS_STOPPED])))
    .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const pid = event?.payload?.processPid;
  const group = event?.payload?.processGroupId;
  if (event?.eventType !== LOCAL_PROCESS_STOPPED || typeof pid !== "number" ||
      !Number.isSafeInteger(pid) || pid <= 1 || group !== pid || !absent(pid) || !absent(-pid)) return null;
  const payload = event.payload;
  if (payload?.completionSource !== undefined) {
    if (payload.completionSource !== "owned_child_completion") return null;
    const identity = payload.identity;
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
    const observed = identity as Record<string, unknown>;
    const { runnerInstanceId, environmentLeaseId, runId: receiptRunId,
      normalizedSessionId, turnId, itemId } = observed;
    if (typeof runnerInstanceId !== "string" || typeof environmentLeaseId !== "string" ||
        typeof receiptRunId !== "string" || typeof normalizedSessionId !== "string" ||
        typeof turnId !== "string" || typeof itemId !== "string") return null;
    const [run] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId))).limit(1);
    if (!run || run.runtimeMode !== "native" || payload.companyId !== companyId || payload.runId !== runId ||
        payload.agentId !== run.agentId || payload.issueId !== run.nativeIssueId ||
        payload.nativeSessionId !== run.nativeSessionId || payload.runnerInstanceId !== run.runnerInstanceId ||
        observed.runId !== runId || observed.normalizedSessionId !== run.nativeSessionId ||
        observed.runnerInstanceId !== run.runnerInstanceId ||
        typeof payload.processStartedAt !== "string" || !Number.isFinite(Date.parse(payload.processStartedAt)) ||
        typeof payload.observedAt !== "string" || !Number.isFinite(Date.parse(payload.observedAt)) ||
        (run.processStartedAt !== null && run.processStartedAt.getTime() !== Date.parse(payload.processStartedAt)) ||
        (run.processPid !== null && (run.processPid !== pid || run.processGroupId !== group || run.processStartedAt === null)) ||
        (payload.exitCode === null && payload.signal === null) ||
        (payload.exitCode !== null && (typeof payload.exitCode !== "number" || !Number.isSafeInteger(payload.exitCode) || payload.exitCode < 0)) ||
        (payload.signal !== null && (typeof payload.signal !== "string" || !/^SIG[A-Z0-9]+$/.test(payload.signal))) ||
        ![observed.runnerInstanceId, observed.environmentLeaseId, observed.runId,
          observed.normalizedSessionId, observed.turnId, observed.itemId]
          .every(value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value))) return null;
    return { processPid: pid, processGroupId: pid, terminationReceipt: {
      identity: { runnerInstanceId, environmentLeaseId, runId: receiptRunId,
        normalizedSessionId, turnId, itemId }, processStartedAt: payload.processStartedAt,
      exitCode: payload.exitCode, signal: payload.signal, observedAt: payload.observedAt } };
  }
  // Legacy absence observations remain distinguishable. They never acquire
  // an owned completion ACK or new provider/checkpoint authority retroactively.
  return { processPid: pid, processGroupId: pid };
}
