import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { ISSUE_DISPOSITION_REPAIR_RETRY_REASON } from "@paperclipai/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, companies, createDb, heartbeatRuns,
  issueComments, issueRecoveryActions, issueRelations, issues, nativeRunFinalizations, startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";

const effects = vi.hoisted(() => ({ telemetry: vi.fn(), provider: vi.fn(() => {
  throw new Error("provider_forbidden_in_lock_preservation_test");
}) }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: effects.telemetry }) }));
vi.mock("../adapters/index.js", async () => ({
  ...await vi.importActual<Record<string, unknown>>("../adapters/index.js"),
  getServerAdapter: effects.provider,
}));
import { issueService } from "../services/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { collectDispositionRepairSourceState } from "../services/recovery/disposition-repair.js";
import { readNativeContinuationHold } from "../services/native-runtime/native-continuation-hold.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { legacyDispositionFingerprint } from "../services/recovery/legacy-continuation.js";
import {
  deliverReconciledExecutions, markExecutionReconciliation, validateExecutionReconciliation,
} from "../services/execution-recovery-resolution.js";

// Exercise real clear/adopt writers against an isolated PostgreSQL database.
// No provider dispatch, company API, or production database is permitted.
describe("native continuation ownership: automatic clear and adoption", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const observations: Record<string, unknown>[] = [];
  const enqueueWakeup = vi.fn(async () => { throw new Error("wake_forbidden_in_lock_preservation_test"); });

  beforeAll(async () => {
    if (process.env.DATABASE_URL || process.env.PGHOST || process.env.PGPORT || process.env.PGSERVICE) {
      throw new Error("external_database_environment_forbidden");
    }
    temporary = await startEmbeddedPostgresTestDatabase("native-hold-lock-");
    const url = new URL(temporary.connectionString);
    if (url.hostname !== "127.0.0.1" || ["3100", "3317", "3319", "6200", "54329"].includes(url.port)) {
      throw new Error("isolated_test_database_required");
    }
    db = createDb(temporary.connectionString);
    expect(await db.select().from(companies)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  }, 90_000);

  afterEach(async () => {
    if (!db) return;
    expect(effects.provider).not.toHaveBeenCalled();
    expect(effects.telemetry).not.toHaveBeenCalled();
    expect(enqueueWakeup).not.toHaveBeenCalled();
    await db.delete(nativeRunFinalizations);
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    // Delayed repair Runs reference their Wake. Clear Runs before Wakes so the
    // real scheduled-successor control cannot contaminate the next case.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    try {
      if (process.env.COLO_LOCK_TRACE) writeFileSync(process.env.COLO_LOCK_TRACE, JSON.stringify({
        qualification: "isolated synthetic clear/adopt writers only; not company acceptance",
        observations, providerCalls: effects.provider.mock.calls.length,
        telemetryCalls: effects.telemetry.mock.calls.length, wakeCalls: enqueueWakeup.mock.calls.length,
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } finally {
      await temporary?.cleanup();
    }
  }, 30_000);

  async function seed(input: { checkout?: boolean; phase?: "retryable_failure" | "terminal_failure";
    status?: "blocked" | "in_progress"; successor?: boolean; revoked?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const runId = randomUUID(), actorRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic native ownership",
      issuePrefix: `N${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      defaultResponsibleUserId: "synthetic-owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic engineer", role: "engineer",
      status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic retained continuation",
      status: input.status ?? "blocked", assigneeAgentId: input.revoked ? null : agentId });
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "failed",
        nativePhase: input.phase ?? "retryable_failure", finishedAt: new Date(),
        processPid: null, processGroupId: null, contextSnapshot: { issueId, taskId: issueId } },
      { id: actorRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "queued",
        contextSnapshot: { issueId, taskId: issueId } },
    ]);
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: input.checkout ? runId : null,
      executionAgentNameKey: "synthetic-engineer", executionLockedAt: new Date() }).where(eq(issues.id, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId,
      phase: input.phase ?? "retryable_failure", resultId: null, leaseOwner: null, leaseExpiresAt: null,
      recoveryState: "resuming_session", nextAttemptAt: new Date(Date.now() + 60_000),
      failureDetail: input.successor ? { successorRunId: actorRunId } : null });
    const readIssue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    return { companyId, agentId, issueId, runId, actorRunId, readIssue };
  }

  it.each([false, true])("retains same-run continuation through sweep (checkout=%s)", async checkout => {
    const f = await seed({ checkout });
    const result = await recoveryService(db, { enqueueWakeup }).sweepStaleIssueLocks();
    const actual = await f.readIssue();
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "issue.stale_lock_cleared"));
    observations.push({ kind: "held_sweep", checkout, cleared: result.cleared,
      executionRetained: actual.executionRunId === f.runId, checkoutRetained: actual.checkoutRunId === (checkout ? f.runId : null),
      auditRows: audit.length });
    expect(result).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
    expect(actual.executionRunId).toBe(f.runId);
    expect(actual.checkoutRunId).toBe(checkout ? f.runId : null);
    expect(audit).toHaveLength(0);
    const rows = await db.select().from(heartbeatRuns);
    const counted = await db.execute(sql`select count(*)::int as n from heartbeat_runs`);
    expect(rows).toHaveLength(2);
    expect(counted[0]?.n).toBe(rows.length);
  });

  it.each(["terminal", "successor"] as const)("still clears genuinely ended ownership (%s)", async kind => {
    const f = await seed({ checkout: true, phase: kind === "terminal" ? "terminal_failure" : "retryable_failure",
      successor: kind === "successor" });
    const result = await recoveryService(db, { enqueueWakeup }).sweepStaleIssueLocks();
    const actual = await f.readIssue();
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "issue.stale_lock_cleared"));
    observations.push({ kind: "ended_sweep", reason: kind, cleared: result.cleared,
      executionCleared: actual.executionRunId === null, checkoutCleared: actual.checkoutRunId === null,
      auditRows: audit.length });
    expect(result).toEqual({ cleared: 1, issueIds: [f.issueId], terminalizedRunIds: [] });
    expect(actual.executionRunId).toBeNull();
    expect(actual.checkoutRunId).toBeNull();
    expect(audit).toHaveLength(1);
  });

  it("does not erase an unreconciled coordinator merely because the current assignee is absent", async () => {
    const f = await seed({ revoked: true });
    const result = await recoveryService(db, { enqueueWakeup }).sweepStaleIssueLocks();
    const actual = await f.readIssue();
    observations.push({ kind: "unassigned_coordinator", cleared: result.cleared,
      executionRetained: actual.executionRunId === f.runId });
    expect(result.cleared).toBe(0);
    expect(actual.executionRunId).toBe(f.runId);
    expect(actual.assigneeAgentId).toBeNull();
  });

  it.each(["cancel", "reassign"] as const)("still honors an explicit owner %s through the real issue update", async kind => {
    const f = await seed({ checkout: true });
    const before = await f.readIssue();
    expect(before.executionRunId).toBe(f.runId);
    const updated = await issueService(db).update(f.issueId, kind === "cancel"
      ? { status: "cancelled" } : { assigneeAgentId: null });
    expect(updated).not.toBeNull();
    const afterOwnerUpdate = await f.readIssue();
    const result = await recoveryService(db, { enqueueWakeup }).sweepStaleIssueLocks();
    const actual = await f.readIssue();
    observations.push({ kind: "explicit_owner_update", operation: kind,
      executionClearedByUpdate: afterOwnerUpdate.executionRunId === null,
      checkoutClearedByUpdate: afterOwnerUpdate.checkoutRunId === null, extraSweepClears: result.cleared });
    expect(afterOwnerUpdate.executionRunId).toBeNull();
    expect(afterOwnerUpdate.checkoutRunId).toBeNull();
    expect(actual.executionRunId).toBeNull();
    expect(actual.checkoutRunId).toBeNull();
    expect(result.cleared).toBe(0);
    if (kind === "cancel") expect(actual.status).toBe("cancelled");
    else expect(actual.assigneeAgentId).toBeNull();
  });

  it.each([false, true])("refuses another checkout while native continuation owns the issue (checkout=%s)", async checkout => {
    const f = await seed({ checkout, status: "in_progress" });
    const before = await f.readIssue();
    let refused = false;
    try { await issueService(db).checkout(f.issueId, f.agentId, ["in_progress"], f.actorRunId); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("checkout conflict")) throw error;
      refused = true;
    }
    const actual = await f.readIssue();
    observations.push({ kind: "held_checkout", checkout, refused,
      executionRetained: actual.executionRunId === f.runId, checkoutRetained: actual.checkoutRunId === before.checkoutRunId });
    expect(refused).toBe(true);
    expect(actual).toEqual(before);
  });

  it.each([
    { review: false, held: true },
    { review: true, held: true },
    { review: false, held: false },
    { review: true, held: false },
  ])("stranded recovery preserves pending ownership before unavailable-owner escalation (review=$review, held=$held)", async ({ review, held }) => {
    const f = await seed({ checkout: true, status: "in_progress",
      phase: held ? "retryable_failure" : "terminal_failure" });
    // Remove the unrelated queued checkout actor. It must not become the
    // execution path that makes this retention test pass for the wrong reason.
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actorRunId));
    if (review) {
      const reviewerId = randomUUID(), stageId = randomUUID();
      await db.insert(agents).values({ id: reviewerId, companyId: f.companyId,
        name: "Synthetic paused reviewer", role: "engineer", status: "paused",
        adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
      await db.update(issues).set({ status: "in_review", executionPolicy: {
        mode: "normal", commentRequired: true,
        stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId, userId: null }] }],
      }, executionState: {
        status: "pending", currentStageId: stageId, currentStageIndex: 0,
        currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
        returnAssignee: { type: "agent", agentId: f.agentId, userId: null },
        reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      } }).where(eq(issues.id, f.issueId));
    } else {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    }
    const before = await f.readIssue();
    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    const actual = await f.readIssue();
    const actions = await db.select().from(issueRecoveryActions);
    const runs = await db.select().from(heartbeatRuns);
    const counted = await db.execute(sql`select count(*)::int as n from heartbeat_runs`);
    observations.push({ kind: "stranded_unavailable_owner", review, held,
      escalated: result.escalated, skipped: result.skipped, status: actual.status,
      executionRetained: actual.executionRunId === f.runId,
      checkoutRetained: actual.checkoutRunId === f.runId, recoveryActions: actions.length,
      runRows: runs.length, sqlRunCount: counted[0]?.n });
    expect(runs).toHaveLength(1);
    expect(counted[0]?.n).toBe(runs.length);
    if (held) {
      expect(actual.executionRunId).toBe(f.runId);
      expect(actual.checkoutRunId).toBe(f.runId);
      expect(actual.status).toBe(before.status);
      expect(result.escalated).toBe(0);
      expect(result.skipped).toBe(1);
      expect(actions).toHaveLength(0);
    } else {
      expect(result.escalated).toBe(1);
      expect(actual.status).toBe("blocked");
      expect(actual.executionRunId).toBeNull();
      expect(actual.checkoutRunId).toBeNull();
      expect(actions).toHaveLength(1);
      expect(actions[0]?.ownerType).toBe("board");
    }
  });

  it.each([true, false])("active board recovery preserves native continuation while a healthy child runs (held=%s)", async held => {
    const f = await seed({ checkout: true, status: "blocked",
      phase: held ? "retryable_failure" : "terminal_failure" });
    if (!held) {
      // A terminal control must not retain an unsettled native recovery marker.
      await db.update(nativeRunFinalizations).set({ recoveryState: null })
        .where(eq(nativeRunFinalizations.runId, f.runId));
    }
    // This actor is only a checkout-conflict fixture from seed(). It is not a
    // live source path in this scenario and must not resolve the action first.
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actorRunId));
    const childId = randomUUID(), childRunId = randomUUID();
    await db.insert(issues).values({ id: childId, companyId: f.companyId,
      parentId: f.issueId, title: "Synthetic delegated child", status: "in_progress",
      assigneeAgentId: f.agentId });
    await db.insert(heartbeatRuns).values({ id: childRunId, companyId: f.companyId,
      agentId: f.agentId, nativeIssueId: childId, runtimeMode: "native", status: "queued",
      contextSnapshot: { issueId: childId, taskId: childId } });
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "deliberate_wait_without_target", ownerType: "board",
      previousOwnerAgentId: f.agentId, returnOwnerAgentId: f.agentId,
      cause: "deliberate_wait_without_target", fingerprint: "synthetic-active-board-child",
      nextAction: "Review the source outcome.", wakePolicy: { type: "board_escalation" },
    });
    const before = await f.readIssue();
    const child = (await db.select().from(issues).where(eq(issues.id, childId)))[0]!;
    const relationsBefore = await db.select().from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, f.issueId));
    expect(relationsBefore).toHaveLength(0);
    const sourceState = await collectDispositionRepairSourceState(db, { issue: before });
    const childState = await collectDispositionRepairSourceState(db, { issue: child });
    const holdBefore = await readNativeContinuationHold(db, { issue: before, runId: f.runId });
    expect(holdBefore).toBe(held);
    expect(sourceState.hasDurableWaitingPath).toBe(false);
    expect(childState.hasActiveExecutionPath).toBe(true);
    expect(action.status).toBe("active");
    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    const actual = await f.readIssue();
    const relationsAfter = await db.select().from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, f.issueId));
    const actions = await db.select().from(issueRecoveryActions);
    const runs = await db.select().from(heartbeatRuns);
    const counted = await db.execute(sql`select count(*)::int as n from heartbeat_runs`);
    observations.push({ kind: "active_board_healthy_child", held, holdBefore,
      sourceActivePath: sourceState.hasActiveExecutionPath,
      sourceDurablePath: sourceState.hasDurableWaitingPath,
      childActivePath: childState.hasActiveExecutionPath,
      beforeStatus: before.status, afterStatus: actual.status,
      executionRetained: actual.executionRunId === f.runId,
      checkoutRetained: actual.checkoutRunId === f.runId,
      actionBeforeStatus: action.status, actionAfterStatus: actions[0]?.status,
      actionResolutionNote: actions[0]?.resolutionNote,
      sourceWasProcessed: result.issueIds.includes(f.issueId),
      issueUnchanged: JSON.stringify(actual) === JSON.stringify(before),
      ownerRetained: actual.assigneeAgentId === before.assigneeAgentId,
      blockerRelationsBefore: relationsBefore.length, blockerRelationsAfter: relationsAfter.length,
      childBlockerCreated: relationsAfter.some(row => row.issueId === childId && row.type === "blocks"),
      actionRows: actions.length, runRows: runs.length, sqlRunCount: counted[0]?.n });
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map(run => run.id)).size).toBe(runs.length);
    expect(counted[0]?.n).toBe(runs.length);
    expect(actions).toHaveLength(1);
    expect(actual.status).toBe("blocked");
    if (held) {
      expect(actual).toEqual(before);
      expect(actual.executionRunId).toBe(f.runId);
      expect(actual.checkoutRunId).toBe(f.runId);
      expect(relationsAfter).toEqual(relationsBefore);
      expect(actions[0]?.status).toBe("active");
      expect(actions[0]?.resolutionNote).toBeNull();
    } else {
      expect(actual.executionRunId).toBeNull();
      expect(actual.checkoutRunId).toBeNull();
      expect(actions[0]?.status).toBe("resolved");
      expect(actions[0]?.resolutionNote).toBe("durable_path_restored:healthy_child");
      expect(relationsAfter).toHaveLength(1);
      expect(relationsAfter[0]).toMatchObject({ issueId: childId, relatedIssueId: f.issueId, type: "blocks" });
    }
  });

  it.each([true, false])("bounded repair does not reserve a delayed successor while native continuation is pending (held=%s)", async held => {
    const f = await seed({ checkout: true, status: "blocked",
      phase: held ? "retryable_failure" : "terminal_failure" });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actorRunId));
    if (!held) {
      // This normal control has actually ended continuation, not merely changed
      // the phase while retaining a contradictory resuming marker.
      await db.update(nativeRunFinalizations).set({ recoveryState: null })
        .where(eq(nativeRunFinalizations.runId, f.runId));
    }
    const before = await f.readIssue();
    const sourceState = await collectDispositionRepairSourceState(db, { issue: before });
    expect(sourceState.hasDurableWaitingPath).toBe(false);
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "deliberate_wait_without_target", ownerType: "agent", ownerAgentId: f.agentId,
      returnOwnerAgentId: f.agentId, cause: "deliberate_wait_without_target",
      fingerprint: sourceState.fingerprint, attemptCount: 1, maxAttempts: 5,
      nextAction: "Revalidate the source disposition.",
      wakePolicy: { type: "bounded_owner_disposition_repair", retryAgentId: f.agentId, attempt: 1, maxAttempts: 5 },
    });
    // The actual failed native repair run belongs to this action. There is no
    // unrelated queued source Run that can resolve the action as a new path.
    await db.update(heartbeatRuns).set({ contextSnapshot: {
      issueId: f.issueId, taskId: f.issueId, recoveryActionId: action.id,
      retryReason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
      dispositionRepairFingerprint: sourceState.fingerprint, dispositionRepairAttempt: 1,
    } }).where(eq(heartbeatRuns.id, f.runId));
    const holdBefore = await readNativeContinuationHold(db, { issue: before, runId: f.runId });
    expect(holdBefore).toBe(held);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const startedAt = Date.now();
    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    const actual = await f.readIssue();
    const runs = await db.select().from(heartbeatRuns);
    const wakes = await db.select().from(agentWakeupRequests);
    const actions = await db.select().from(issueRecoveryActions);
    const scheduled = runs.filter(run => run.status === "scheduled_retry");
    const counts = await db.execute(sql`select
      (select count(*)::int from heartbeat_runs) as runs,
      (select count(*)::int from agent_wakeup_requests) as wakes,
      (select count(*)::int from issue_recovery_actions) as actions`);
    observations.push({ kind: "bounded_native_repair", held, holdBefore,
      sourceActivePath: sourceState.hasActiveExecutionPath,
      sourceDurablePath: sourceState.hasDurableWaitingPath,
      issueUnchanged: JSON.stringify(actual) === JSON.stringify(before),
      runRows: runs.length, wakeRows: wakes.length, actionRows: actions.length,
      sqlCounts: counts[0], scheduledRunRows: scheduled.length,
      scheduledAttempt: scheduled[0]?.scheduledRetryAttempt ?? null,
      scheduledDelayPositive: Boolean(scheduled[0]?.scheduledRetryAt && scheduled[0].scheduledRetryAt.getTime() > startedAt),
      actionAttempt: actions[0]?.attemptCount, actionStatus: actions[0]?.status,
      continuationRequeued: result.continuationRequeued });
    expect(new Set(runs.map(run => run.id)).size).toBe(runs.length);
    expect(counts[0]).toEqual({ runs: runs.length, wakes: wakes.length, actions: actions.length });
    expect(actual).toEqual(before);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe("active");
    if (held) {
      expect(runs).toHaveLength(1);
      expect(wakes).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
      expect(actions[0]?.attemptCount).toBe(1);
      expect(result.continuationRequeued).toBe(0);
    } else {
      expect(runs).toHaveLength(2);
      expect(wakes).toHaveLength(1);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.scheduledRetryAttempt).toBe(2);
      expect(scheduled[0]?.scheduledRetryAt!.getTime()).toBeGreaterThan(startedAt);
      expect(scheduled[0]?.contextSnapshot).toMatchObject({ recoveryActionId: action.id,
        dispositionRepairAttempt: 2, retryOfRunId: f.runId });
      expect(wakes[0]).toMatchObject({ status: "queued", runId: scheduled[0]?.id });
      expect(actions[0]?.attemptCount).toBe(2);
      expect(result.continuationRequeued).toBe(1);
    }
  });

  it("automatic update preserves an already resumed exact native run without relying on H", async () => {
    const f = await seed({ checkout: true, status: "in_progress" });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actorRunId));
    // Model the state after the ordinary resumption claim has committed.
    // No transition is forced through a concurrently held issue lock.
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: "synthetic-resumer" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId: f.companyId,
      title: "Synthetic existing blocker", status: "blocked" });
    await db.insert(issueRelations).values({ companyId: f.companyId,
      issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId,
      agentId: f.agentId, source: "automation", requestedByActorType: "user",
      requestedByActorId: "synthetic-owner", status: "queued", payload: { issueId: f.issueId } }).returning();
    const before = await f.readIssue();
    const relationsBefore = await db.select().from(issueRelations);
    expect(await readNativeContinuationHold(db, { issue: before, runId: f.runId })).toBe(false);
    const updated = await issueService(db, { preserveHeldNativeContinuation: true })
      .update(f.issueId, { status: "blocked", assigneeAgentId: null, blockedByIssueIds: [] });
    const actual = await f.readIssue();
    const relationsAfter = await db.select().from(issueRelations);
    const [wakeAfter] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id));
    observations.push({ kind: "automatic_update_already_resumed_native", initialRunStatus: "running",
      initialFinalizationPhase: "observed", holdBefore: false, updateReturnedNull: updated === null,
      issueUnchanged: JSON.stringify(actual) === JSON.stringify(before),
      relationsBefore: relationsBefore.length, relationsAfter: relationsAfter.length,
      humanWakeBefore: wake!.status, humanWakeAfter: wakeAfter?.status,
      executionRetained: actual.executionRunId === f.runId, checkoutRetained: actual.checkoutRunId === f.runId });
    expect(updated).toBeNull();
    expect(actual).toEqual(before);
    expect(relationsAfter).toEqual(relationsBefore);
    expect(wakeAfter).toEqual(wake);
  });

  it("automatic update fences a hold formed after its plain read without cancelling human intent", async () => {
    const f = await seed({ checkout: true, status: "blocked", phase: "terminal_failure" });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actorRunId));
    await db.update(nativeRunFinalizations).set({ recoveryState: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId: f.companyId,
      title: "Synthetic existing blocker", status: "blocked" });
    await db.insert(issueRelations).values({ companyId: f.companyId,
      issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId,
      agentId: f.agentId, source: "automation", requestedByActorType: "user",
      requestedByActorId: "synthetic-owner", status: "queued", payload: { issueId: f.issueId } }).returning();
    const before = await f.readIssue();
    const relationsBefore = await db.select().from(issueRelations);
    expect(await readNativeContinuationHold(db, { issue: before, runId: f.runId })).toBe(false);
    let crossed = 0;
    const wrapTransaction = (tx: typeof db) => new Proxy(tx, { get(target, property, receiver) {
      if (property !== "select") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...fields: unknown[]) => {
        const builder = Reflect.apply(target.select, target, fields);
        const from = builder.from.bind(builder);
        Object.defineProperty(builder, "from", { value: (table: unknown) => {
          const selected = Reflect.apply(from, builder, [table]) as {
            limit: (...args: unknown[]) => PromiseLike<unknown>;
          };
          if (table !== nativeRunFinalizations) return selected;
          const limit = selected.limit.bind(selected);
          Object.defineProperty(selected, "limit", { value: (...args: unknown[]) => {
            const query = Reflect.apply(limit, selected, args) as PromiseLike<unknown>;
            const then = query.then.bind(query);
            Object.defineProperty(query, "then", { value: (
              resolve?: (value: unknown) => unknown, reject?: (reason: unknown) => unknown,
            ) =>
              then(async (rows: unknown) => {
                if (crossed++ === 0) {
                  // Synthetic ordering probe only: the separate connection
                  // changes F without I, after the real plain read completes.
                  // This is not proof of normal B production reachability.
                  await db.update(nativeRunFinalizations).set({ phase: "retryable_failure",
                    recoveryState: "resuming_session" }).where(eq(nativeRunFinalizations.runId, f.runId));
                }
                return rows;
              }).then(resolve, reject) });
            return query;
          }});
          return selected;
        }});
        return builder;
      };
    }});
    const intercepted = new Proxy(db, { get(target, property, receiver) {
      if (property === "transaction") return (callback: (tx: typeof db) => Promise<unknown>) =>
        target.transaction(tx => callback(wrapTransaction(tx as unknown as typeof db)));
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }});
    const updated = await issueService(intercepted, { preserveHeldNativeContinuation: true })
      .update(f.issueId, { status: "blocked", assigneeAgentId: null, blockedByIssueIds: [] });
    const actual = await f.readIssue();
    const relationsAfter = await db.select().from(issueRelations);
    const [wakeAfter] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id));
    const finalization = (await db.select().from(nativeRunFinalizations))[0]!;
    observations.push({ kind: "automatic_update_hold_formed_after_plain_read", crossed,
      finalizationPhase: finalization.phase, recoveryState: finalization.recoveryState,
      updateReturnedNull: updated === null, issueUnchanged: JSON.stringify(actual) === JSON.stringify(before),
      relationsBefore: relationsBefore.length, relationsAfter: relationsAfter.length,
      humanWakeBefore: wake!.status, humanWakeAfter: wakeAfter?.status,
      executionRetained: actual.executionRunId === f.runId,
      checkoutRetained: actual.checkoutRunId === f.runId,
      qualification: "Synthetic separate F transition without I; normal B reachability unproved" });
    expect(crossed).toBe(1);
    expect(finalization).toMatchObject({ phase: "retryable_failure", recoveryState: "resuming_session" });
    expect(updated).toBeNull();
    expect(actual).toEqual(before);
    expect(relationsAfter).toEqual(relationsBefore);
    expect(wakeAfter).toEqual(wake);
  });

  async function legacySlotForNativeState(mode: "normal_terminal" | "safe_successor" | "terminal_unknown" | "operator_pending" | "explicit_null_comment") {
    const f = await seed({ status: "in_progress", phase: mode === "operator_pending" || mode === "explicit_null_comment"
      ? "retryable_failure" : "terminal_failure" });
    const now = Date.now();
    await db.update(heartbeatRuns).set({ createdAt: new Date(now - 3_000) }).where(eq(heartbeatRuns.id, f.runId));
    // These bindings are the actual shape produced by ambiguous-state handling,
    // safe replacement, and explicit source disposition. Unbound alone is not
    // a settlement receipt; UNKNOWN below retains its separate board hold.
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null,
      executionAgentNameKey: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
    await db.update(nativeRunFinalizations).set({ recoveryState: mode === "normal_terminal" ? null : "resuming_session" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    if (mode === "terminal_unknown") await db.update(nativeRunFinalizations).set({ failureDetail: {
      recoveryMode: "ambiguous_state", recoveryOwner: { kind: "board" },
      originalFailureCode: "native_session_interrupted",
    } }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (mode === "safe_successor") {
      const successorId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: successorId, companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded", finishedAt: new Date(now - 2_000),
        createdAt: new Date(now - 2_000), contextSnapshot: { issueId: f.issueId, taskId: f.issueId } });
      await db.update(nativeRunFinalizations).set({ failureDetail: { successorRunId: successorId } })
        .where(eq(nativeRunFinalizations.runId, f.runId));
    }
    let attention: typeof issueRecoveryActions.$inferSelect | undefined;
    if (mode === "terminal_unknown" || mode === "operator_pending" || mode === "explicit_null_comment") {
      [attention] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId,
        sourceIssueId: f.issueId, kind: "active_run_watchdog", ownerType: "board",
        returnOwnerAgentId: f.agentId, cause: mode === "terminal_unknown" ? "native_session_interrupted" : "uncertain_provider_action",
        status: mode === "terminal_unknown" ? "active" : "resolved",
        fingerprint: f.runId, evidence: { runId: f.runId, automaticRecovery: mode === "terminal_unknown"
          ? { replay: "blocked" } : undefined }, nextAction: "Inspect the original synthetic execution; do not replay." }).returning();
      if (mode === "operator_pending") {
        const decision = { runId: f.runId, providerStopped: true as const, actionOutcome: "not_performed" as const,
          outcomeEvidence: "The isolated fixture contains no external action or live provider." };
        await validateExecutionReconciliation({ db, companyId: f.companyId, issueId: f.issueId,
          agentId: f.agentId, sourceRunId: f.runId, decision });
        await markExecutionReconciliation(db, attention!, decision, "synthetic-owner");
        [attention] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, attention!.id));
      } else if (mode === "explicit_null_comment") {
        // Exact writer-shaped durable receipt. The route/admission itself is
        // deliberately not invoked, and null commentId is valid for a retry.
        await db.update(nativeRunFinalizations).set({ failureDetail: { replacementDenied: "explicit_user_continuation" } })
          .where(eq(nativeRunFinalizations.runId, f.runId));
        await db.update(issueRecoveryActions).set({ evidence: { runId: f.runId,
          explicitUserContinuation: { actorId: "synthetic-owner", recordedAt: new Date().toISOString(),
            runId: f.actorRunId, previousRunId: f.runId, commentId: null } } })
          .where(eq(issueRecoveryActions.id, attention!.id));
        [attention] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, attention!.id));
      }
    }
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null, status: "succeeded",
      createdAt: new Date(now - 1_000), finishedAt: new Date(now - 1_000),
      livenessState: "blocked", contextSnapshot: { issueId: f.issueId, taskId: f.issueId } })
      .where(eq(heartbeatRuns.id, f.actorRunId));
    const repairId = randomUUID();
    const fingerprint = legacyDispositionFingerprint(f.companyId, f.issueId, f.agentId, f.actorRunId);
    await db.insert(heartbeatRuns).values({ id: repairId, companyId: f.companyId, agentId: f.agentId,
      runtimeMode: "legacy", status: "scheduled_retry", scheduledRetryAt: new Date(now),
      scheduledRetryReason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON, createdAt: new Date(now),
      retryOfRunId: f.actorRunId, contextSnapshot: { issueId: f.issueId, taskId: f.issueId,
        retryReason: ISSUE_DISPOSITION_REPAIR_RETRY_REASON, dispositionRepairSourceRunId: f.actorRunId,
        dispositionRepairFingerprint: fingerprint, dispositionRepairAttempt: 1,
        legacyDispositionEpisode: { id: f.actorRunId, attempt: 1, maxAttempts: 2 } } });
    return { ...f, repairId, attention };
  }

  it.each(["normal_terminal", "safe_successor", "terminal_unknown", "operator_pending", "explicit_null_comment"] as const)(
    "A5 actual legacy gates distinguish settled history and reconciliation waiting (%s)", async mode => {
      const f = await legacySlotForNativeState(mode);
      const before = await f.readIssue();
      const attentionBefore = await db.select().from(issueRecoveryActions);
      const countsBefore = await db.execute(sql`select (select count(*)::int from heartbeat_runs) as runs,
        (select count(*)::int from agent_wakeup_requests) as wakes`);
      const state = await collectDispositionRepairSourceState(db, { issue: before, excludeRunId: f.repairId });
      const recovery = recoveryService(db, { enqueueWakeup });
      const legacyBlock = await recovery.legacyRepairDispatchBlock(f.repairId);
      const gate = await createPostgresRunDispatchAdapter(db).evaluateScheduledRetryGate({
        runId: f.repairId, companyId: f.companyId,
        retryReasonOverride: ISSUE_DISPOSITION_REPAIR_RETRY_REASON, now: new Date() });
      const countsAfter = await db.execute(sql`select (select count(*)::int from heartbeat_runs) as runs,
        (select count(*)::int from agent_wakeup_requests) as wakes`);
      const attentionAfter = await db.select().from(issueRecoveryActions);
      const waiting = mode === "terminal_unknown" || mode === "operator_pending";
      observations.push({ kind: "A5_legacy_gate", mode, nativePath: state.hasNativeRecoveryPath,
        activePath: state.hasActiveExecutionPath, durableWait: state.hasDurableWaitingPath,
        durableReason: state.durablePathReason, legacyBlock, gate, countsBefore: countsBefore[0], countsAfter: countsAfter[0],
        attentionUnchanged: JSON.stringify(attentionBefore) === JSON.stringify(attentionAfter),
        qualification: "Synthetic reachable F shapes; safe successor completion is a local control, not physical cleanup proof." });
      expect(state.hasNativeRecoveryPath).toBe(false);
      expect(state.hasActiveExecutionPath).toBe(false);
      expect(state.hasDurableWaitingPath).toBe(waiting);
      if (waiting) expect(legacyBlock).not.toBeNull();
      else expect(legacyBlock).toBeNull();
      expect(gate.allowed).toBe(!waiting);
      expect(countsAfter).toEqual(countsBefore);
      expect(await f.readIssue()).toEqual(before);
      expect(attentionAfter).toEqual(attentionBefore);
    });

  it("A5 a reconciled pending outbox still uses the existing explicit delivery entry", async () => {
    const f = await legacySlotForNativeState("operator_pending");
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.repairId));
    let requested = 0;
    let deliveredRunId: string | null = null;
    await deliverReconciledExecutions(db, async (agentId, options) => {
      requested++;
      expect(agentId).toBe(f.agentId);
      expect(options?.contextSnapshot).toMatchObject({ previousRunId: f.runId, recoveryActionId: f.attention!.id });
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId,
        runtimeMode: "legacy", status: "queued", contextSnapshot: options?.contextSnapshot }).returning();
      deliveredRunId = run!.id;
      return run!;
    });
    await deliverReconciledExecutions(db, async () => { requested++; throw new Error("duplicate_explicit_delivery"); });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.attention!.id));
    observations.push({ kind: "A5_explicit_delivery", requested, continuationDelivery: action?.evidence.continuationDelivery,
      returnedRunMatchesReceipt: action?.evidence.continuationRunId === deliveredRunId,
      qualification: "Existing outbox callback accepted a synthetic DB Run; no actual scheduler/provider dispatch." });
    expect(requested).toBe(1);
    expect(action?.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: deliveredRunId });
  });

  it("A5 pending native settlement with a lease is preserved even though H is false", async () => {
    const f = await seed({ checkout: true, status: "blocked" });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actorRunId));
    await db.update(nativeRunFinalizations).set({ leaseOwner: "synthetic-settlement-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const before = await f.readIssue();
    const finalizationsBefore = await db.select().from(nativeRunFinalizations);
    expect(await readNativeContinuationHold(db, { issue: before, runId: f.runId })).toBe(false);
    const updated = await issueService(db, { preserveHeldNativeContinuation: true })
      .update(f.issueId, { status: "blocked", assigneeAgentId: null });
    const after = await f.readIssue();
    observations.push({ kind: "A5_pending_lease", holdBefore: false, updateNull: updated === null,
      issueUnchanged: JSON.stringify(after) === JSON.stringify(before) });
    expect(updated).toBeNull();
    expect(after).toEqual(before);
    expect(await db.select().from(nativeRunFinalizations)).toEqual(finalizationsBefore);
  });

  it.each([false, true])("A5 orphaned native settlement preserves source and existing attention (existing=%s)", async existing => {
    const f = await seed({ status: "in_progress" });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actorRunId));
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null,
      executionAgentNameKey: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
    if (existing) await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "active", ownerType: "board", cause: "uncertain_provider_action",
      fingerprint: "synthetic-unrelated-existing-attention", evidence: { runId: randomUUID(),
        executionReconciliation: { runId: randomUUID(), actorId: "synthetic-owner", recordedAt: new Date(0).toISOString() },
        continuationDelivery: "delegated" }, nextAction: "Preserve the unrelated recorded decision.",
      wakePolicy: { type: "board_escalation" }, attemptCount: 2, maxAttempts: 3 });
    if (existing) await db.update(nativeRunFinalizations).set({ failureDetail: { replacementDenied: "operator_reconciled" } })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const before = await f.readIssue();
    const runsBefore = await db.select().from(heartbeatRuns);
    const finalsBefore = await db.select().from(nativeRunFinalizations);
    const actionsBefore = await db.select().from(issueRecoveryActions);
    const commentsBefore = await db.select().from(issueComments);
    const recovery = recoveryService(db, { enqueueWakeup });
    await recovery.reconcileStrandedAssignedIssues();
    const once = await db.select().from(issueRecoveryActions);
    const auditOnce = await db.select().from(activityLog).where(eq(activityLog.action, "issue.native_continuation_attention_required"));
    await recovery.reconcileStrandedAssignedIssues();
    const twice = await db.select().from(issueRecoveryActions);
    const auditTwice = await db.select().from(activityLog).where(eq(activityLog.action, "issue.native_continuation_attention_required"));
    observations.push({ kind: "A5_orphan_attention", existing, actionRows: twice.length,
      orphanedRunIds: twice[0]?.evidence.nativeOrphanedRunIds, auditOnce: auditOnce.length, auditTwice: auditTwice.length,
      sourceUnchanged: JSON.stringify(await f.readIssue()) === JSON.stringify(before),
      markerWithoutMatchingSourceReceipt: existing,
      qualification: "Unknown binding loss; not explicit revoke or permission to replay." });
    expect(twice).toHaveLength(1);
    expect(twice[0]?.evidence.nativeOrphanedRunIds).toEqual([f.runId]);
    if (existing) {
      const { evidence: priorEvidence, updatedAt: _priorUpdated, ...priorFields } = actionsBefore[0]!;
      const { evidence: nextEvidence, updatedAt: _nextUpdated, ...nextFields } = twice[0]!;
      expect(nextFields).toEqual(priorFields);
      const { nativeOrphanedRunIds: _ids, ...unrelatedEvidence } = nextEvidence;
      expect(unrelatedEvidence).toEqual(priorEvidence);
    }
    expect(twice).toEqual(once);
    expect(auditOnce).toHaveLength(1);
    expect(auditTwice).toEqual(auditOnce);
    expect(await f.readIssue()).toEqual(before);
    expect(await db.select().from(heartbeatRuns)).toEqual(runsBefore);
    expect(await db.select().from(nativeRunFinalizations)).toEqual(finalsBefore);
    expect(await db.select().from(issueComments)).toEqual(commentsBefore);
  });

  it.each([false, true])("A5 board escalation commits auxiliary changes only after its source write (formed=%s)", async formed => {
    const f = await legacySlotForNativeState("normal_terminal");
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.repairId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, taskId: f.issueId,
      legacyDispositionEpisode: { id: f.actorRunId, attempt: 2, maxAttempts: 2 } } })
      .where(eq(heartbeatRuns.id, f.actorRunId));
    const fingerprint = legacyDispositionFingerprint(f.companyId, f.issueId, f.agentId, f.actorRunId);
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId,
      sourceIssueId: f.issueId, kind: "deliberate_wait_without_target", status: "active",
      ownerType: "agent", ownerAgentId: f.agentId, returnOwnerAgentId: f.agentId,
      cause: "deliberate_wait_without_target", fingerprint, attemptCount: 2, maxAttempts: 2,
      nextAction: "Retain the bounded repair until its source disposition is accepted.",
      wakePolicy: { type: "bounded_owner_disposition_repair", attempt: 2, maxAttempts: 2 } }).returning();
    const before = await f.readIssue();
    const commentsBefore = await db.select().from(issueComments);
    let crossed = 0;
    let formedSource: typeof issues.$inferSelect | undefined;
    const wrap = (tx: typeof db) => new Proxy(tx, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "select") return typeof value === "function" ? value.bind(target) : value;
      return (...fields: unknown[]) => {
        const builder = Reflect.apply(target.select, target, fields);
        const from = builder.from.bind(builder);
        Object.defineProperty(builder, "from", { value: (table: unknown) => {
          const selected = Reflect.apply(from, builder, [table]) as { for: (...args: unknown[]) => unknown };
          if (table !== issues) return selected;
          const lock = selected.for.bind(selected);
          Object.defineProperty(selected, "for", { value: (...args: unknown[]) => {
            const query = Reflect.apply(lock, selected, args) as PromiseLike<unknown>;
            const then = query.then.bind(query);
            Object.defineProperty(query, "then", { value: (resolve?: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve().then(async () => {
                if (crossed++ === 0 && formed) await db.transaction(async other => {
                  await other.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
                  await other.update(nativeRunFinalizations).set({ phase: "retryable_failure", recoveryState: "resuming_session" })
                    .where(eq(nativeRunFinalizations.runId, f.runId));
                  await other.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId })
                    .where(eq(issues.id, f.issueId));
                  [formedSource] = await other.select().from(issues).where(eq(issues.id, f.issueId));
                });
              }).then(() => then(resolve, reject)) });
            return query;
          }});
          return selected;
        }});
        return builder;
      };
    }});
    const intercepted = new Proxy(db, { get(target, property, receiver) {
      if (property === "transaction") return (callback: (tx: typeof db) => Promise<unknown>) =>
        target.transaction(tx => callback(wrap(tx as unknown as typeof db)));
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }});
    const result = await recoveryService(intercepted, { enqueueWakeup }).reconcileLegacyContinuation(f.actorRunId);
    const [afterAction] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    const after = await f.readIssue();
    const commentsAfter = await db.select().from(issueComments);
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "issue.disposition_repair_escalated"));
    observations.push({ kind: "A5_board_escalation", formed, crossed, result, beforeOwner: action!.ownerType,
      afterOwner: afterAction?.ownerType, actionUnchanged: JSON.stringify(afterAction) === JSON.stringify(action),
      commentsBefore: commentsBefore.length, commentsAfter: commentsAfter.length, auditRows: audit.length,
      formationRevision: formedSource?.revision ?? null, finalRevision: after.revision,
      sourceMatchesFormation: formed ? JSON.stringify(after) === JSON.stringify(formedSource) : null,
      qualification: "Real separate I-then-F transaction at first I-lock boundary; local ordering probe, not B production reachability proof." });
    expect(crossed).toBeGreaterThanOrEqual(1);
    if (formed) {
      expect(result).toBe("skipped");
      expect(afterAction).toEqual(action);
      // The competing UPDATE legitimately advances the DB-managed revision.
      // Compare against its committed row, never a reconstruction that omits
      // that trigger effect or the automatic writer's subsequent mutations.
      expect(formedSource).toEqual({ ...before, executionRunId: f.runId,
        checkoutRunId: f.runId, revision: before.revision + 1 });
      expect(after).toEqual(formedSource);
      expect(commentsAfter).toEqual(commentsBefore);
      expect(audit).toHaveLength(0);
    } else {
      expect(result).toBe("escalated");
      expect(afterAction).toMatchObject({ ownerType: "board", status: "active" });
      expect(after.status).toBe("blocked");
      expect(commentsAfter).toHaveLength(commentsBefore.length + 1);
      expect(audit).toHaveLength(1);
    }
  });

  it("does not clear a run resumed between the sweep's run and coordinator snapshots", async () => {
    const f = await seed();
    let crossed = 0;
    // Use real SELECT/UPDATE statements. The seam only orders the independently
    // committed state transition between the sweep's two actual read queries.
    const intercepted = new Proxy(db, { get(target, property, receiver) {
      if (property !== "select") return Reflect.get(target, property, receiver);
      return (...fields: unknown[]) => {
        const builder = Reflect.apply(target.select, target, fields);
        const from = builder.from.bind(builder);
        Object.defineProperty(builder, "from", { value: (table: unknown) => {
          const selected = Reflect.apply(from, builder, [table]) as {
            where: (...conditions: unknown[]) => PromiseLike<unknown>;
          };
          if (table !== nativeRunFinalizations) return selected;
          const where = selected.where.bind(selected);
          Object.defineProperty(selected, "where", { value: (...conditions: unknown[]) => {
            const query = Reflect.apply(where, selected, conditions) as PromiseLike<unknown>;
            const then = query.then.bind(query);
            Object.defineProperty(query, "then", { value: (resolve: unknown, reject: unknown) => {
              const transition = crossed++ === 0 ? db.transaction(async tx => {
                await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
                await tx.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: "synthetic-resumer" })
                  .where(eq(nativeRunFinalizations.runId, f.runId));
                await tx.update(heartbeatRuns).set({ status: "running", finishedAt: null })
                  .where(eq(heartbeatRuns.id, f.runId));
              }) : Promise.resolve();
              return transition.then(() => Reflect.apply(then, query, [resolve, reject]));
            }});
            return query;
          }});
          return selected;
        }});
        return builder;
      };
    }});
    const result = await recoveryService(intercepted, { enqueueWakeup }).sweepStaleIssueLocks();
    const actual = await f.readIssue();
    const run = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "issue.stale_lock_cleared"));
    observations.push({ kind: "mixed_snapshot_resume", crossed, cleared: result.cleared,
      runStatus: run.status, executionRetained: actual.executionRunId === f.runId, auditRows: audit.length });
    expect(crossed).toBe(1);
    expect(run.status).toBe("running");
    expect(result.cleared).toBe(0);
    expect(actual.executionRunId).toBe(f.runId);
    expect(audit).toHaveLength(0);
  });
});
