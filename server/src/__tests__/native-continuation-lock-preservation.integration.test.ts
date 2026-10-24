import { createHash, randomUUID } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import express from "express";
import request from "supertest";
import { eq, inArray, sql } from "drizzle-orm";
import { ISSUE_DISPOSITION_REPAIR_RETRY_REASON } from "@paperclipai/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns,
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
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { collectDispositionRepairSourceState } from "../services/recovery/disposition-repair.js";
import { readNativeContinuationHold } from "../services/native-runtime/native-continuation-hold.js";
import { claimNativeSessionResumptions } from "../services/native-runtime/native-finalization-reconciler.js";
import { isCancelledNativeStartup } from "../services/cancelled-native-startup.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
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
  const cleanDatabaseProofs: Record<string, unknown>[] = [];
  let ownedDataDirectory = "";
  let ownedPort = 0;
  let fixtureRelations: Array<{ oid: number; schema: string; name: string }> = [];
  let migrationRelations: Array<{ oid: number; schema: string; name: string }> = [];
  let initialMigrationState: unknown = null;
  const enqueueWakeup = vi.fn(async () => { throw new Error("wake_forbidden_in_lock_preservation_test"); });

  async function assertOwnedDatabase() {
    if (!temporary || !ownedDataDirectory || !ownedPort) throw new Error("owned_test_database_proof_missing");
    const identity = await db.execute(sql`select current_database() as name,
      host(inet_server_addr()) as host, inet_server_port() as port,
      current_setting('data_directory') as data_directory`);
    expect(identity[0]).toMatchObject({ name: "paperclip", host: "127.0.0.1", port: ownedPort,
      data_directory: ownedDataDirectory });
  }

  async function readMigrationState() {
    return Promise.all(migrationRelations.map(async table => {
      const rows = await db.execute(sql`select to_jsonb(m) as row from
        ${sql.identifier(table.schema)}.${sql.identifier(table.name)} m order by m.id`);
      return { schema: table.schema, name: table.name, rows: rows.length,
        sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
    }));
  }

  async function assertCleanFixtureGraph(stage: string) {
    await assertOwnedDatabase();
    const counts = await db.execute(sql.join(fixtureRelations.map(table => sql`
      select ${table.oid}::int as oid, count(*)::int as rows from
      ${sql.identifier(table.schema)}.${sql.identifier(table.name)}`), sql` union all `));
    expect(counts).toHaveLength(fixtureRelations.length);
    expect(new Set(counts.map(row => row.oid)).size).toBe(fixtureRelations.length);
    expect(counts.every(row => row.rows === 0)).toBe(true);
    const migrations = await readMigrationState();
    expect(migrations).toEqual(initialMigrationState);
    cleanDatabaseProofs.push({ stage, fixtureTables: counts.length, nonemptyTables: counts.filter(row => row.rows !== 0).length,
      fixtureGraphSHA256: createHash("sha256").update(JSON.stringify(fixtureRelations)).digest("hex"),
      migrationState: migrations, migrationsUnchanged: true, ownedDatabaseVerified: true,
      ownedPort, ownedDataDirectoryBasename: basename(ownedDataDirectory) });
  }

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
    ownedPort = Number(url.port);
    const identity = await db.execute(sql`select current_setting('data_directory') as data_directory`);
    ownedDataDirectory = realpathSync(String(identity[0]?.data_directory ?? ""));
    const ownedRoot = realpathSync(process.env.TMPDIR ?? "");
    const location = relative(ownedRoot, ownedDataDirectory);
    if (!location || location.startsWith("..") || isAbsolute(location) || !basename(ownedDataDirectory).startsWith("native-hold-lock-")) {
      throw new Error("database_not_inside_runner_owned_temporary_root");
    }
    const graph = await db.execute(sql`with recursive fixture(oid) as (
      select 'companies'::regclass::oid
      union select constraint_row.conrelid from pg_constraint constraint_row
      inner join fixture on constraint_row.confrelid = fixture.oid where constraint_row.contype = 'f'
    ) select relation.oid::int as oid, namespace.nspname as schema, relation.relname as name
      from fixture inner join pg_class relation on relation.oid = fixture.oid
      inner join pg_namespace namespace on namespace.oid = relation.relnamespace order by relation.oid`);
    fixtureRelations = graph.map(row => ({ oid: Number(row.oid), schema: String(row.schema), name: String(row.name) }));
    const migrations = await db.execute(sql`select relation.oid::int as oid,
      namespace.nspname as schema, relation.relname as name from pg_class relation
      inner join pg_namespace namespace on namespace.oid = relation.relnamespace
      where relation.relname = '__drizzle_migrations' and relation.relkind = 'r' order by relation.oid`);
    migrationRelations = migrations.map(row => ({ oid: Number(row.oid), schema: String(row.schema), name: String(row.name) }));
    expect(fixtureRelations.length).toBeGreaterThan(0);
    expect(migrationRelations.length).toBeGreaterThan(0);
    expect(migrationRelations.every(table => !fixtureRelations.some(fixture => fixture.oid === table.oid))).toBe(true);
    initialMigrationState = await readMigrationState();
    await assertCleanFixtureGraph("beforeAll");
  }, 90_000);

  beforeEach(async () => { await assertCleanFixtureGraph("beforeEach"); });

  afterEach(async () => {
    if (!db) return;
    try {
      expect(effects.provider).not.toHaveBeenCalled();
      expect(effects.telemetry).not.toHaveBeenCalled();
      expect(enqueueWakeup).not.toHaveBeenCalled();
    } finally {
      // Only the helper-created cluster inside this runner's isolated TMPDIR
      // can reach this write. PostgreSQL follows the actual FK graph; new
      // fixture dependants never require another hand-maintained delete list.
      await assertOwnedDatabase();
      await db.execute(sql`truncate table companies cascade`);
      await assertCleanFixtureGraph("afterEach");
    }
  });

  afterAll(async () => {
    try {
      if (process.env.COLO_LOCK_TRACE) writeFileSync(process.env.COLO_LOCK_TRACE, JSON.stringify({
        qualification: "isolated synthetic clear/adopt writers only; not company acceptance",
        observations, cleanDatabaseProofs, providerCalls: effects.provider.mock.calls.length,
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

  it.each([false, true, "agent"] as const)("A5 orphaned native settlement preserves source and existing attention (existing=%s)", async existing => {
    const f = await seed({ status: "in_progress" });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actorRunId));
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null,
      executionAgentNameKey: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
    if (existing) await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "active", ownerType: existing === "agent" ? "agent" : "board",
      ownerAgentId: existing === "agent" ? f.agentId : null, cause: "uncertain_provider_action",
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
      if (existing === "agent") {
        const { nextAction: originalText, ...originalOtherFields } = priorFields;
        const { nextAction: amendedText, ...amendedOtherFields } = nextFields;
        expect(amendedOtherFields).toEqual(originalOtherFields);
        expect(amendedText.startsWith(originalText)).toBe(true);
        expect(amendedText).toContain(f.runId);
        expect(amendedText).not.toBe(originalText);
      } else expect(nextFields).toEqual(priorFields);
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

  it.each(["running_observed", "failed_resuming"] as const)(
    "A6 a genuinely active bound native child remains a healthy delegated path (%s)", async phase => {
      const f = await seed({ checkout: true, status: "blocked", phase: "terminal_failure" });
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actorRunId));
      await db.update(nativeRunFinalizations).set({ recoveryState: null })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      const childId = randomUUID(), childRunId = randomUUID();
      await db.insert(issues).values({ id: childId, companyId: f.companyId, parentId: f.issueId,
        title: "Synthetic active native delegated child", status: "in_progress", assigneeAgentId: f.agentId });
      await db.insert(heartbeatRuns).values({ id: childRunId, companyId: f.companyId,
        agentId: f.agentId, nativeIssueId: childId, runtimeMode: "native",
        status: phase === "running_observed" ? "running" : "failed",
        nativePhase: phase === "running_observed" ? "observed" : "retryable_failure",
        contextSnapshot: { issueId: childId, taskId: childId } });
      await db.update(issues).set({ executionRunId: childRunId, checkoutRunId: childRunId })
        .where(eq(issues.id, childId));
      await db.insert(nativeRunFinalizations).values({ runId: childRunId, companyId: f.companyId,
        issueId: childId, phase: phase === "running_observed" ? "observed" : "retryable_failure",
        resultId: null, recoveryState: phase === "running_observed" ? null : "resuming_session",
        leaseOwner: phase === "running_observed" ? "synthetic-current-native-owner" : null,
        leaseExpiresAt: phase === "running_observed" ? new Date(Date.now() + 60_000) : null });
      const action = await issueRecoveryActionService(db).upsertSourceScoped({
        companyId: f.companyId, sourceIssueId: f.issueId, kind: "deliberate_wait_without_target",
        ownerType: "board", returnOwnerAgentId: f.agentId, cause: "deliberate_wait_without_target",
        fingerprint: "synthetic-parent-active-native-child", nextAction: "Inspect the delegated native work.",
        wakePolicy: { type: "board_escalation" } });
      const child = (await db.select().from(issues).where(eq(issues.id, childId)))[0]!;
      const state = await collectDispositionRepairSourceState(db, { issue: child });
      await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
      const [afterAction] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      const relations = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, f.issueId));
      observations.push({ kind: "A6_healthy_native_child", phase, childActive: state.hasActiveExecutionPath,
        childNative: state.hasNativeRecoveryPath, actionStatus: afterAction?.status,
        resolutionNote: afterAction?.resolutionNote, blockerRows: relations.length,
        childRemainsExact: (await db.select().from(issues).where(eq(issues.id, childId)))[0]?.executionRunId === childRunId });
      expect(state.hasActiveExecutionPath).toBe(true);
      expect(afterAction).toMatchObject({ status: "resolved", resolutionNote: "durable_path_restored:healthy_child" });
      expect(relations).toHaveLength(1);
      expect(relations[0]).toMatchObject({ issueId: childId, relatedIssueId: f.issueId, type: "blocks" });
    });

  function createRecoveryApp(actor: any = { type: "board", source: "local_implicit" }) {
    // Match the existing route test's actor stub; authorization is the real
    // route gate, while production authentication is outside this fixture.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as any, { recoveryActionEnqueueWakeup: enqueueWakeup }));
    app.use(errorHandler);
    return app;
  }

  async function persistNativeResumeEvidence(f: Awaited<ReturnType<typeof seed>>) {
    // Only the actual resumption claim is exercised: no backend/session is
    // opened. A durable provider identity prevents an ambiguous-envelope
    // terminalization from masquerading as a successful reclaim rejection.
    await db.update(heartbeatRuns).set({ runnerProfileJson: {
      nativeExecutionInput: { schema: "paperclip.native-execution-input.v1",
        binding: { companyId: f.companyId, issueId: f.issueId, runId: f.runId, agentId: f.agentId } },
      sessionCheckpoint: { backendKind: "codex_app_server", sessionId: "synthetic-native-session",
        providerSessionId: "synthetic-provider-session", activeTurnId: "synthetic-existing-turn",
        identity: { runId: f.runId } },
    } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, f.runId));
  }

  async function seedBoardNativeHandoff(kind: "terminal" | "never_claimed" | "retryable" = "terminal") {
    const f = await seed({ checkout: true, status: "in_progress",
      phase: kind === "retryable" ? "retryable_failure" : "terminal_failure" });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actorRunId));
    // This is the real ambiguous writer's board-owned evidence shape, not an
    // inference that terminal phase or an absent PID proves a provider stop.
    if (kind !== "retryable") await db.update(nativeRunFinalizations).set({ failureDetail: {
      recoveryMode: "ambiguous_state", recoveryOwner: { kind: "board" },
      originalFailureCode: "native_session_interrupted",
    } }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (kind === "retryable") await persistNativeResumeEvidence(f);
    if (kind === "never_claimed") {
      await db.update(heartbeatRuns).set({ status: "cancelled", nativePhase: "observed",
        finishedAt: new Date(), processPid: null, processGroupId: null,
        processStartedAt: null, sessionIdAfter: null,
        resultJson: { startupPreparationSettledAt: new Date().toISOString() } })
        .where(eq(heartbeatRuns.id, f.runId));
      await db.update(nativeRunFinalizations).set({ phase: "observed", attempt: 0,
        controllerGeneration: 0, controllerBootId: null, controllerPid: null,
        leaseOwner: null, leaseExpiresAt: null, resultId: null,
        recoveryState: null, failureDetail: null }).where(eq(nativeRunFinalizations.runId, f.runId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [finalization] = await db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, f.runId));
      expect(await isCancelledNativeStartup(db, run!, finalization)).toBe(true);
      expect(await isCancelledNativeStartup(db, run!, { ...finalization!, attempt: 1 })).toBe(false);
    }
    const newAgentId = randomUUID();
    await db.insert(agents).values({ id: newAgentId, companyId: f.companyId,
      name: "Synthetic BOARD handoff assignee", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
    await issueService(db).update(f.issueId, { assigneeAgentId: newAgentId });
    const issueAfterReassignment = await f.readIssue();
    expect(issueAfterReassignment).toMatchObject({ assigneeAgentId: newAgentId,
      executionRunId: null, checkoutRunId: null });
    await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    const [action] = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action).toMatchObject({ status: "active", ownerType: "board",
      returnOwnerAgentId: newAgentId, cause: "native_continuation_requires_reconciliation" });
    expect(action?.evidence.runId).toBe(f.runId);
    const body = { actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId: f.runId, providerStopped: true,
        actionOutcome: "not_performed", outcomeEvidence:
          "Synthetic outcome evidence in an isolated database; no real provider or external action is asserted." } };
    return { ...f, newAgentId, action: action!, body,
      resolve: (app = createRecoveryApp()) => request(app)
        .post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(body),
      readAction: async () => (await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action!.id)))[0]!,
    };
  }

  async function receiveSyntheticBoardDelivery(f: Awaited<ReturnType<typeof seedBoardNativeHandoff>>) {
    let requested = 0;
    let deliveredRunId: string | null = null;
    await deliverReconciledExecutions(db, async (agentId, options) => {
      requested++;
      expect(agentId).toBe(f.newAgentId);
      expect(options?.contextSnapshot).toMatchObject({ issueId: f.issueId,
        previousRunId: f.runId, recoveryActionId: f.action.id, forceFreshSession: true });
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId,
        runtimeMode: "legacy", status: "queued", contextSnapshot: options?.contextSnapshot }).returning();
      deliveredRunId = run!.id;
      return run!;
    });
    expect(requested).toBe(1);
    expect(deliveredRunId).not.toBeNull();
    const dispatch = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId: deliveredRunId!, companyId: f.companyId, expectedStatus: "queued", now: new Date() });
    const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, deliveredRunId!));
    expect(dispatch).toMatchObject({ outcome: "not_stale" });
    expect(queued).toMatchObject({ agentId: f.newAgentId, status: "queued", retryOfRunId: f.runId });
    await deliverReconciledExecutions(db, async () => { requested++; throw new Error("duplicate_BOARD_delivery"); });
    expect(requested).toBe(1);
    expect((await f.readAction()).evidence).toMatchObject({ continuationDelivery: "delivered",
      continuationRunId: deliveredRunId });
    return { requested, deliveredRunId, dispatch, queuedStatus: queued!.status };
  }

  it("A6 BOARD reconciles a terminal old-owner native execution and delivers once to the current owner", async () => {
    const f = await seedBoardNativeHandoff();
    const sourceBefore = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    const finalizationBefore = (await db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, f.runId)))[0]!;
    const actionBefore = await f.readAction();
    const actorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: actorRunId, companyId: f.companyId,
      agentId: f.newAgentId, runtimeMode: "legacy", status: "succeeded", finishedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId } });
    const agentResponse = await f.resolve(createRecoveryApp({ type: "agent", source: "agent_key",
      companyId: f.companyId, agentId: f.newAgentId, runId: actorRunId }));
    expect(agentResponse.status).toBe(403);
    expect(agentResponse.body.error).toBe("Board access required");
    expect(await f.readAction()).toEqual(actionBefore);
    const response = await f.resolve();
    const observation: Record<string, unknown> = { kind: "A6_BOARD_terminal_handoff",
      agentHTTPStatus: agentResponse.status, agentDenial: agentResponse.body.error,
      boardHTTPStatus: response.status, boardError: response.body.error ?? null,
      qualification: "Real HTTP route with current-owner succeeded actor Run; provider stop and production authentication are not asserted." };
    observations.push(observation);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await f.readIssue()).toMatchObject({ assigneeAgentId: f.newAgentId, status: "todo",
      executionRunId: null, checkoutRunId: null });
    const recorded = await f.readAction();
    expect(recorded).toMatchObject({ status: "resolved", returnOwnerAgentId: f.newAgentId });
    expect(recorded.evidence).toMatchObject({ continuationDelivery: "pending",
      executionReconciliation: { runId: f.runId, providerStopped: true, actionOutcome: "not_performed" } });
    const receipt = recorded.evidence.executionReconciliation as Record<string, unknown>;
    expect(typeof receipt.actorId).toBe("string");
    expect(typeof receipt.recordedAt).toBe("string");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(sourceBefore);
    const [finalizationAfter] = await db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(finalizationAfter).toMatchObject({ phase: finalizationBefore.phase,
      recoveryState: finalizationBefore.recoveryState, resultId: null,
      failureDetail: { ...finalizationBefore.failureDetail, replacementDenied: "operator_reconciled" } });
    const delivery = await receiveSyntheticBoardDelivery(f);
    Object.assign(observation, delivery, { historicalSourcePreserved: true,
      qualification: "Real HTTP route, validator, receipt, outbox and queued gate; actor stub and synthetic DB wake callback only. No provider stop or production authentication acceptance." });
  });

  it("A6 BOARD can explicitly hand off a proven never-claimed cancelled startup", async () => {
    const f = await seedBoardNativeHandoff("never_claimed");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    const sourceBefore = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    const response = await f.resolve();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const delivery = await receiveSyntheticBoardDelivery(f);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(sourceBefore);
    observations.push({ kind: "A6_BOARD_cancelled_startup", boardHTTPStatus: response.status,
      ...delivery, qualification: "Complete existing JS never-claimed proof plus explicit BOARD decision; not automatic permission after Stop." });
  });

  it.each(["stale_return_owner", "decision_other_run", "retryable_without_resume_state", "cancelled_attempt_one",
    "coordinator_lease", "live_pid", "other_active_native_issue_only", "other_orphan",
    "legacy_other_owner", "remote_release_without_receipt"] as const)(
    "A6 BOARD refuses unsafe cross-owner reconciliation (%s)", async boundary => {
      const f = await seedBoardNativeHandoff(boundary === "cancelled_attempt_one" ? "never_claimed" : "terminal");
      if (boundary === "stale_return_owner") await db.update(issueRecoveryActions)
        .set({ returnOwnerAgentId: f.agentId }).where(eq(issueRecoveryActions.id, f.action.id));
      if (boundary === "decision_other_run") f.body.executionReconciliation.runId = randomUUID();
      if (boundary === "retryable_without_resume_state") {
        await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", recoveryState: null })
          .where(eq(nativeRunFinalizations.runId, f.runId));
        await db.update(heartbeatRuns).set({ nativePhase: "retryable_failure" })
          .where(eq(heartbeatRuns.id, f.runId));
      }
      if (boundary === "cancelled_attempt_one") await db.update(nativeRunFinalizations)
        .set({ attempt: 1 }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (boundary === "coordinator_lease") await db.update(nativeRunFinalizations)
        .set({ leaseOwner: "synthetic-active-controller", leaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      if (boundary === "live_pid") await db.update(heartbeatRuns)
        .set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.runId));
      if (boundary === "other_active_native_issue_only") await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId: f.newAgentId, runtimeMode: "native",
        nativeIssueId: f.issueId, status: "running", contextSnapshot: {} });
      if (boundary === "other_orphan") {
        const otherRunId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.companyId, agentId: f.agentId,
          runtimeMode: "native", nativeIssueId: f.issueId, status: "failed", finishedAt: new Date(),
          contextSnapshot: { issueId: f.issueId } });
        await db.insert(nativeRunFinalizations).values({ runId: otherRunId, companyId: f.companyId,
          issueId: f.issueId, phase: "retryable_failure", resultId: null, recoveryState: "resuming_session" });
      }
      if (boundary === "legacy_other_owner") await db.update(heartbeatRuns)
        .set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, f.runId));
      if (boundary === "remote_release_without_receipt") await db.insert(environmentLeases).values({
        companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId,
        provider: "synthetic_remote", providerLeaseId: "synthetic-remote-resource",
        status: "released", releasedAt: new Date(), cleanupStatus: "success", metadata: {} });
      const before = { issue: await f.readIssue(), action: await f.readAction(),
        runs: await db.select().from(heartbeatRuns), finals: await db.select().from(nativeRunFinalizations),
        wakes: await db.select().from(agentWakeupRequests) };
      const response = await f.resolve();
      observations.push({ kind: "A6_BOARD_refusal", boundary, httpStatus: response.status,
        message: response.body.error, qualification: "Synthetic exact source/action/current-owner route boundary; no provider calls." });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(await f.readIssue()).toEqual(before.issue);
      expect(await f.readAction()).toEqual(before.action);
      expect(await db.select().from(heartbeatRuns)).toEqual(before.runs);
      expect(await db.select().from(nativeRunFinalizations)).toEqual(before.finals);
      expect(await db.select().from(agentWakeupRequests)).toEqual(before.wakes);
    });

  it("A6 BOARD delivery is invalidated when the current target changes before delivery", async () => {
    const f = await seedBoardNativeHandoff();
    const response = await f.resolve();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const thirdAgentId = randomUUID();
    await db.insert(agents).values({ id: thirdAgentId, companyId: f.companyId,
      name: "Synthetic newer assignee", role: "engineer", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" } });
    await issueService(db).update(f.issueId, { assigneeAgentId: thirdAgentId });
    const sourceBefore = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    let requested = 0;
    await deliverReconciledExecutions(db, async () => { requested++; throw new Error("stale_target_delivery"); });
    const action = await f.readAction();
    expect(requested).toBe(0);
    expect(action.evidence.continuationDelivery).toBe("invalidated");
    expect((await f.readIssue()).assigneeAgentId).toBe(thirdAgentId);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(sourceBefore);
    observations.push({ kind: "A6_BOARD_delivery_invalidated", requested,
      continuationDelivery: action.evidence.continuationDelivery, qualification: "Real default reassignment between receipt and synthetic outbox delivery; no new wake." });
  });

  it("A7 native resumption cannot reclaim a retryable old-owner orphan after reassignment", async () => {
    const f = await seedBoardNativeHandoff("retryable");
    const snapshot = async () => ({ issue: await f.readIssue(), action: await f.readAction(),
      run: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!,
      finalization: (await db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, f.runId)))[0]!,
      wakes: await db.select().from(agentWakeupRequests) });
    const before = await snapshot();
    expect(before.issue).toMatchObject({ assigneeAgentId: f.newAgentId, executionRunId: null, checkoutRunId: null });
    expect(before.run).toMatchObject({ status: "failed", agentId: f.agentId, runtimeMode: "native" });
    expect(before.finalization).toMatchObject({ phase: "retryable_failure", recoveryState: "resuming_session",
      resultId: null, leaseOwner: null });
    const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: "synthetic-old-owner-reaper",
      runIds: [f.runId], now: new Date() });
    const after = await snapshot();
    observations.push({ kind: "A7_reassigned_reclaim", claimCount: claims.length,
      oldRunClaimed: claims.some(claim => claim.runId === f.runId), runStatus: after.run.status,
      phase: after.finalization.phase, leaseOwner: after.finalization.leaseOwner,
      unchanged: JSON.stringify(after) === JSON.stringify(before),
      qualification: "Actual claim function only, complete claim-required envelope/checkpoint identity; no provider open/recover, no external effects." });
    expect(claims).toHaveLength(0);
    expect(after).toEqual(before);
  });

  it("A7 bound same-owner resumption backs off on an issue lock then claims one lease and prevents BOARD takeover", async () => {
    const f = await seed({ checkout: true, status: "in_progress" });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actorRunId));
    await persistNativeResumeEvidence(f);
    const snapshot = async () => ({ issue: await f.readIssue(),
      run: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!,
      finalization: (await db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, f.runId)))[0]! });
    const before = await snapshot();
    let announce!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { announce = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      announce(); await released;
    });
    const transactionErrors: string[] = [];
    const observedDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return async (...args: any[]) => {
        try { return await (target.transaction as any)(...args); }
        catch (error) {
          const detail = error as { code?: string; cause?: { code?: string } };
          transactionErrors.push(detail.cause?.code ?? detail.code ?? "unknown");
          throw error;
        }
      };
    } });
    await acquired;
    try {
      const blocked = await claimNativeSessionResumptions({ db: observedDb,
        runnerInstanceId: "synthetic-lock-contender", runIds: [f.runId], now: new Date() });
      expect(blocked).toHaveLength(0);
      expect(transactionErrors).toEqual(["55P03"]);
      expect(await snapshot()).toEqual(before);
    } finally { release(); await holder; }
    // All are real due rows, but none owns the current binding. Put them before
    // the valid Run so an early candidate LIMIT cannot starve a legitimate
    // resume forever. UUID subtraction is deterministic even for a low UUID.
    const targetNumber = BigInt(`0x${f.runId.replaceAll("-", "")}`);
    const rejectedIds = Array.from({ length: 26 }, (_, index) => {
      const hex = (targetNumber - BigInt(index + 1)).toString(16).padStart(32, "0");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    });
    expect(rejectedIds.every(id => id < f.runId)).toBe(true);
    expect(new Set(rejectedIds).size).toBe(26);
    const inserted = await db.insert(heartbeatRuns).values(rejectedIds.map(id => ({
      id, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode: "native", status: "failed", finishedAt: new Date(),
      nativePhase: "retryable_failure", contextSnapshot: { issueId: f.issueId },
      runnerProfileJson: { nativeExecutionInput: { schema: "paperclip.native-execution-input.v1",
        binding: { companyId: f.companyId, issueId: f.issueId, runId: id, agentId: f.agentId } },
        sessionCheckpoint: { providerSessionId: "synthetic-rejected-session", activeTurnId: "synthetic-turn" } },
    }))).returning({ id: heartbeatRuns.id });
    expect(inserted).toHaveLength(26);
    await db.insert(nativeRunFinalizations).values(rejectedIds.map(id => ({ runId: id,
      companyId: f.companyId, issueId: f.issueId, phase: "retryable_failure",
      recoveryState: "resuming_session", resultId: null, nextAttemptAt: new Date(0) })));
    const readRejected = async () => ({
      runs: await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, rejectedIds)).orderBy(heartbeatRuns.id),
      finalizations: await db.select().from(nativeRunFinalizations)
        .where(inArray(nativeRunFinalizations.runId, rejectedIds)).orderBy(nativeRunFinalizations.runId),
    });
    const rejectedBefore = await readRejected();
    expect(rejectedBefore.runs).toHaveLength(inserted.length);
    expect(rejectedBefore.finalizations).toHaveLength(rejectedIds.length);
    const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: "synthetic-current-owner",
      runIds: [...rejectedIds, f.runId], limit: 1, now: new Date() });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ runId: f.runId, leaseOwner: expect.stringContaining("synthetic-current-owner:resume:") });
    const claimed = await snapshot();
    expect(claimed.issue).toEqual(before.issue);
    expect(claimed.run).toMatchObject({ id: f.runId, status: "running", finishedAt: null });
    expect(claimed.finalization).toMatchObject({ phase: "observed", leaseOwner: claims[0]!.leaseOwner, resultId: null });
    expect(claimed.finalization.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await readRejected()).toEqual(rejectedBefore);
    // These deliberately unbound distractors are no longer needed for the
    // separate first-claim-wins BOARD check below.
    await db.delete(nativeRunFinalizations).where(inArray(nativeRunFinalizations.runId, rejectedIds));
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.id, rejectedIds));
    const newAgentId = randomUUID();
    await db.insert(agents).values({ id: newAgentId, companyId: f.companyId,
      name: "Synthetic target after a resume claim", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
    await issueService(db).update(f.issueId, { assigneeAgentId: newAgentId });
    await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action).toMatchObject({ ownerType: "board", returnOwnerAgentId: newAgentId });
    expect(action?.evidence.runId).toBe(f.runId);
    const protectedBefore = { ...(await snapshot()), action };
    const response = await request(createRecoveryApp()).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send({
      actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId: f.runId, providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "Synthetic lease precedence counterexample; this request must not override an already claimed native run." },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error).toContain("source or task owner changed");
    expect({ ...(await snapshot()), action: (await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action!.id)))[0] }).toEqual(protectedBefore);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    observations.push({ kind: "A7_bound_resume", nowaitErrors: transactionErrors, claimCount: claims.length,
      sameRun: claims[0]!.runId === f.runId, issuedLease: claimed.finalization.leaseOwner,
      earlierIneligibleCandidates: rejectedIds.length, rejectedCandidatesUnchanged: true, successLimit: 1,
      claimedPhase: claimed.finalization.phase, boardHTTPStatus: response.status,
      qualification: "Real I-lock NOWAIT backoff with a promise barrier, then a same-run lease; real reassignment/BOARD rejects the prior successful claim. No provider/session executed." });
  });

  it("A7 BOARD reconciles a resumable retryable orphan before one delivery and the old Run cannot be reclaimed", async () => {
    const f = await seedBoardNativeHandoff("retryable");
    const before = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    const response = await f.resolve();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const receipt = await f.readAction();
    expect(receipt.evidence).toMatchObject({ continuationDelivery: "pending",
      executionReconciliation: { runId: f.runId, providerStopped: true, actionOutcome: "not_performed" } });
    const [recorded] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(recorded).toMatchObject({ phase: "retryable_failure", recoveryState: "resuming_session",
      resultId: null, leaseOwner: null, failureDetail: { replacementDenied: "operator_reconciled" } });
    const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: "synthetic-after-BOARD",
      runIds: [f.runId], now: new Date() });
    expect(claims).toHaveLength(0);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toEqual(recorded);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(before);
    const delivery = await receiveSyntheticBoardDelivery(f);
    observations.push({ kind: "A7_retryable_BOARD_handoff", boardHTTPStatus: response.status,
      oldRunClaimsAfterReceipt: claims.length, ...delivery,
      qualification: "Actual BOARD receipt and claim fence with both current-binding and marker protections; synthetic DB wake callback only, not a physical provider-stop or concurrent exactly-once proof." });
  });

  async function reassignNativeSource(input: { neverClaimed: boolean }) {
    const f = await seed({ checkout: true, status: "in_progress" });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actorRunId));
    const newAgentId = randomUUID();
    await db.insert(agents).values({ id: newAgentId, companyId: f.companyId,
      name: "Synthetic new assignee", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
    if (input.neverClaimed) {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), processPid: null,
        processGroupId: null, processStartedAt: null, sessionIdAfter: null,
        resultJson: { startupPreparationSettledAt: new Date().toISOString() } }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(nativeRunFinalizations).set({ phase: "observed", attempt: 0,
        controllerGeneration: 0, controllerBootId: null, controllerPid: null,
        leaseOwner: null, leaseExpiresAt: null, resultId: null, recoveryState: null, failureDetail: null })
        .where(eq(nativeRunFinalizations.runId, f.runId));
    }
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [finalization] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const cancelledStartup = await isCancelledNativeStartup(db, run!, finalization);
    if (input.neverClaimed) {
      expect(cancelledStartup).toBe(true);
      // Same row with a claimed attempt is an UNKNOWN control, never proof of
      // a stopped provider. Restore only the synthetic seed before the test.
      expect(await isCancelledNativeStartup(db, run!, { ...finalization!, attempt: 1 })).toBe(false);
    }
    await issueService(db).update(f.issueId, { assigneeAgentId: newAgentId });
    const afterOwnerUpdate = await f.readIssue();
    expect(afterOwnerUpdate.assigneeAgentId).toBe(newAgentId);
    expect(afterOwnerUpdate.executionRunId).toBeNull();
    expect(afterOwnerUpdate.checkoutRunId).toBeNull();
    await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    const queuedId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: queuedId, companyId: f.companyId, agentId: newAgentId,
      runtimeMode: "legacy", status: "queued", contextSnapshot: { issueId: f.issueId, taskId: f.issueId } });
    const dispatch = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId: queuedId, companyId: f.companyId, expectedStatus: "queued", now: new Date() });
    let validatorError: string | null = null;
    try { await validateExecutionReconciliation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: newAgentId, sourceRunId: f.runId, decision: { runId: f.runId,
        providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "Synthetic fixture only; this does not assert a real provider stop." } }); }
    catch (error) { validatorError = error instanceof Error ? error.message : String(error); }
    const actions = await db.select().from(issueRecoveryActions);
    const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedId));
    observations.push({ kind: "A6_reassigned_source", neverClaimed: input.neverClaimed, cancelledStartup,
      assigneeChangedByRealDefaultService: afterOwnerUpdate.assigneeAgentId === newAgentId,
      sourceRunAgentUnchanged: run?.agentId === f.agentId,
      blockerCause: blocker?.cause ?? null, attentionRows: actions.length,
      dispatch, queuedStatus: queued?.status, queuedErrorCode: queued?.errorCode, validatorError,
      qualification: "Only local reassignment/blocker/dispatch/validator facts. No physical provider stop or external outcome is inferred." });
    return { f, blocker, dispatch, queued, validatorError };
  }

  it("A6 reassignment exposes the old-source/current-owner reconciliation refusal chain", async () => {
    const actual = await reassignNativeSource({ neverClaimed: false });
    // Observation of the old contract, not approval to clear an UNKNOWN run.
    // Parent owns the current-agent/operator reconciliation boundary decision.
    expect(actual.blocker).not.toBeNull();
    expect(actual.queued).toMatchObject({ status: "cancelled", errorCode: "execution_reconciliation_required" });
    expect(actual.validatorError).toContain("source or task owner changed");
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
