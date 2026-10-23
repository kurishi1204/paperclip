import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.js";
import { createDurableChatWakeupRequest } from "../services/durable-chat-wakeup.js";

const support = await getEmbeddedPostgresTestSupport();
// macOS arm64 is the owned acceptance host: a failed database probe must fail
// this required regression instead of silently reporting a green skipped suite.
// Other platforms retain the repository's optional embedded-Postgres convention.
const requireEmbeddedPostgres = process.platform === "darwin" && process.arch === "arm64";
const describeEmbedded = support.supported || requireEmbeddedPostgres ? describe : describe.skip;

// Task drain allows a queued admission to be inspected without starting any adapter/provider.
describeEmbedded("fresh Paperclip Runner task preflight", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    if (!support.supported) {
      throw new Error(`Required embedded PostgreSQL is unavailable: ${support.reason ?? "unknown"}`);
    }
    tempDb = await startEmbeddedPostgresTestDatabase("native-task-preflight-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    startTaskDrain();
  }, 60_000);

  afterEach(async () => {
    if (db) await db.execute(sql.raw(`TRUNCATE TABLE "heartbeat_run_events", "heartbeat_runs", "agent_wakeup_requests", "issues", "agents", "companies" RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => {
    stopTaskDrain();
    await db?.$client.end({ timeout: 0 });
    await tempDb?.cleanup();
  });

  async function seed(workMode: "standard" | "planning" | "ask" | "skill_test" | null, adapterType = "paperclip_runner") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = workMode === null ? null : randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Preflight fixture", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: "fixture-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture agent", role: "engineer", status: "idle", adapterType, adapterConfig: adapterType === "paperclip_runner" ? { provider: "acpx", acpxAgent: "claude", model: "claude-opus-5-5" } : {}, runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    if (issueId) await db.insert(issues).values({ id: issueId, companyId, issueNumber: 1, identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`, title: "Fixture task", status: "todo", workMode, assigneeAgentId: agentId, responsibleUserId: "fixture-user" });
    return { companyId, agentId, issueId };
  }

  it("queues one standard task without starting an adapter", async () => {
    const normal = await seed("standard");
    const accepted = await heartbeat.invoke(normal.agentId, "on_demand", { issueId: normal.issueId }, "manual", { actorType: "user", actorId: "fixture-user" });
    expect(accepted).toMatchObject({ status: "queued" });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toHaveLength(1);
  }, 60_000);

  it("rejects a missing task before minting a Run", async () => {
    const missing = await seed(null);
    await expect(heartbeat.invoke(missing.agentId, "on_demand", {}, "manual", { actorType: "user", actorId: "fixture-user" }))
      .rejects.toMatchObject({ status: 409, details: expect.objectContaining({ code: "paperclip_runner_issue_ineligible" }) });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toHaveLength(0);
  }, 60_000);

  it("rejects an ineligible task mode before minting a Run", async () => {
    const badMode = await seed("skill_test");
    await expect(heartbeat.invoke(badMode.agentId, "on_demand", { issueId: badMode.issueId }, "manual", { actorType: "user", actorId: "fixture-user" }))
      .rejects.toMatchObject({ status: 409, details: expect.objectContaining({ code: "paperclip_runner_issue_ineligible" }) });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toHaveLength(0);
  }, 60_000);

  it.each(["planning", "ask"] as const)("queues one %s task under the same Task predicate", async (workMode) => {
    const normal = await seed(workMode);
    const accepted = await heartbeat.invoke(normal.agentId, "on_demand", { issueId: normal.issueId }, "manual", { actorType: "user", actorId: "fixture-user" });
    expect(accepted).toMatchObject({ status: "queued" });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(1);
  }, 60_000);

  it("records a skipped receipt for a non-user missing-task wake", async () => {
    const missing = await seed(null);
    const result = await heartbeat.invoke(missing.agentId, "on_demand", {}, "system", { actorType: "system", actorId: "fixture-scheduler" });
    expect(result).toBeNull();
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason }).from(agentWakeupRequests))
      .toEqual([{ status: "skipped", reason: "paperclip_runner_issue_ineligible" }]);
  }, 60_000);

  it("does not coalesce a fresh unscoped runner wake into an older queued run", async () => {
    const missing = await seed(null);
    await db.insert(heartbeatRuns).values({ companyId: missing.companyId, agentId: missing.agentId,
      invocationSource: "on_demand", triggerDetail: "manual", status: "queued", responsibleUserId: "fixture-user", contextSnapshot: {} });
    await expect(heartbeat.invoke(missing.agentId, "on_demand", {}, "manual", { actorType: "user", actorId: "fixture-user" }))
      .rejects.toMatchObject({ status: 409, details: expect.objectContaining({ code: "paperclip_runner_issue_ineligible" }) });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toHaveLength(0);
  }, 60_000);

  it("rejects an ineligible scoped task before an earlier queued run can defer or coalesce it", async () => {
    const task = await seed("standard");
    const earlier = await heartbeat.invoke(task.agentId, "on_demand", { issueId: task.issueId }, "manual", { actorType: "user", actorId: "fixture-user" });
    expect(earlier).toMatchObject({ status: "queued" });
    await db.update(issues).set({ workMode: "skill_test" }).where(eq(issues.id, task.issueId!));
    await expect(heartbeat.invoke(task.agentId, "on_demand", { issueId: task.issueId }, "manual", { actorType: "user", actorId: "fixture-user" }))
      .rejects.toMatchObject({ status: 409, details: expect.objectContaining({ code: "paperclip_runner_issue_ineligible" }) });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toHaveLength(1);
  }, 60_000);

  it("accepts payload taskId as a scoped alias but rejects taskKey-only unscoped authority", async () => {
    const normal = await seed("standard");
    const accepted = await heartbeat.wakeup(normal.agentId, { source: "on_demand", triggerDetail: "manual", payload: { taskId: normal.issueId }, requestedByActorType: "user", requestedByActorId: "fixture-user" });
    expect(accepted).toMatchObject({ status: "queued" });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(1);
    await db.execute(sql.raw(`TRUNCATE TABLE "heartbeat_run_events", "heartbeat_runs", "agent_wakeup_requests", "issues", "agents", "companies" RESTART IDENTITY CASCADE`));
    const unscoped = await seed("standard");
    await expect(heartbeat.invoke(unscoped.agentId, "on_demand", { taskKey: unscoped.issueId }, "manual", { actorType: "user", actorId: "fixture-user" }))
      .rejects.toMatchObject({ status: 409, details: expect.objectContaining({ code: "paperclip_runner_issue_ineligible" }) });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(0);
  }, 60_000);

  it("queues an eligible board manual wake with its no-coalesce options", async () => {
    const task = await seed("standard");
    const run = await heartbeat.wakeup(task.agentId, { source: "on_demand", triggerDetail: "manual", manualUserWake: true,
      contextSnapshot: { issueId: task.issueId }, requestedByActorType: "user", requestedByActorId: "fixture-user", allowRunCoalescing: false });
    expect(run).toMatchObject({ status: "queued" });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(1);
  }, 60_000);

  it("applies the board manual no-coalesce option to an unscoped runner wake", async () => {
    const missing = await seed(null);
    await expect(heartbeat.wakeup(missing.agentId, { source: "on_demand", triggerDetail: "manual", manualUserWake: true,
      requestedByActorType: "user", requestedByActorId: "fixture-user", allowRunCoalescing: false }))
      .rejects.toMatchObject({ status: 409, details: expect.objectContaining({ code: "paperclip_runner_issue_ineligible" }) });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(0);
  }, 60_000);

  it("preserves coalescing for a still-eligible scoped runner task", async () => {
    const task = await seed("standard");
    const first = await heartbeat.invoke(task.agentId, "on_demand", { issueId: task.issueId }, "manual", { actorType: "user", actorId: "fixture-user" });
    const second = await heartbeat.invoke(task.agentId, "on_demand", { issueId: task.issueId }, "manual", { actorType: "user", actorId: "fixture-user" });
    expect(second?.id).toBe(first?.id);
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(1);
    expect((await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests)).map((row) => row.status).sort())
      .toEqual(["coalesced", "queued"]);
  }, 60_000);

  it("skips a non-user ineligible scoped mode with no Run", async () => {
    const bad = await seed("skill_test");
    const result = await heartbeat.invoke(bad.agentId, "assignment", { issueId: bad.issueId }, "system", { actorType: "system", actorId: "fixture-assignment" });
    expect(result).toBeNull();
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason }).from(agentWakeupRequests))
      .toEqual([{ status: "skipped", reason: "paperclip_runner_issue_ineligible" }]);
  }, 60_000);

  it("retires only its validated execution-wait receipt when the Task mode changed", async () => {
    const task = await seed("skill_test");
    const [stopped] = await db.insert(heartbeatRuns).values({ companyId: task.companyId, agentId: task.agentId,
      invocationSource: "on_demand", triggerDetail: "manual", status: "failed", responsibleUserId: "fixture-user",
      contextSnapshot: { issueId: task.issueId }, runtimeMode: "legacy", finishedAt: new Date(Date.now() - 60_000),
      resultJson: { startupCancellation: { beforeNativeSelection: true }, conversationContinuation: "continue_conversation_v1" },
    }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: task.companyId, issueId: task.issueId!,
      authorType: "user", authorUserId: "fixture-user", body: "resume fixture" }).returning();
    const [pending] = await db.insert(agentWakeupRequests).values({ companyId: task.companyId, agentId: task.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "fixture-user",
      payload: { issueId: task.issueId, commentId: comment!.id,
        _paperclipWakeContext: { issueId: task.issueId, wakeReason: "issue_commented", wakeCommentIds: [comment!.id] } },
    }).returning();
    const [other] = await db.insert(agentWakeupRequests).values({ companyId: task.companyId, agentId: task.agentId,
      source: "automation", reason: "other-deferred", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "another-user", payload: { issueId: task.issueId },
    }).returning();
    await heartbeat.resumeRemoteStopComments(stopped!, pending!.id);
    const receipts = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status,
      reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload }).from(agentWakeupRequests);
    expect(receipts.find((row) => row.id === pending!.id)).toMatchObject({ id: pending!.id, status: "skipped",
      reason: "paperclip_runner_issue_ineligible", payload: { executionWait: {
        reason: "paperclip_runner_issue_ineligible" } } });
    expect(receipts.find((row) => row.id === other!.id)).toMatchObject({ status: "deferred_issue_execution", reason: "other-deferred" });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(1);
  }, 60_000);

  it("advances the timer claim before a skipped generic Runner wake", async () => {
    const missing = await seed(null);
    const now = new Date();
    await db.update(agents).set({ lastHeartbeatAt: new Date(now.getTime() - 120_000),
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 60,
        skipTimerWhenNoActionableWork: false } } }).where(eq(agents.id, missing.agentId));
    // The shared test drain suppresses the scheduler itself. Lift it only for
    // these two ticks; the ineligible Runner still cannot start a provider.
    stopTaskDrain();
    let first: Awaited<ReturnType<typeof heartbeat.tickTimers>>;
    let second: Awaited<ReturnType<typeof heartbeat.tickTimers>>;
    try {
      first = await heartbeat.tickTimers(now);
      second = await heartbeat.tickTimers(now);
    } finally {
      startTaskDrain();
    }
    const [agent] = await db.select({ lastHeartbeatAt: agents.lastHeartbeatAt }).from(agents)
      .where(eq(agents.id, missing.agentId));
    expect(first.skipped).toBe(1);
    expect(second.skipped).toBe(0);
    expect(agent?.lastHeartbeatAt?.getTime()).toBe(now.getTime());
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select({ reason: agentWakeupRequests.reason }).from(agentWakeupRequests))
      .toEqual([{ reason: "paperclip_runner_issue_ineligible" }]);
  }, 60_000);

  it("terminalizes an ineligible durable user wake under its exact receipt ID", async () => {
    const task = await seed("skill_test");
    const commentId = randomUUID(), requestId = randomUUID();
    const request = createDurableChatWakeupRequest({ id: requestId, companyId: task.companyId,
      agentId: task.agentId, issueId: task.issueId!, commentId, requestedByActorType: "user",
      requestedByActorId: "fixture-user", requestedAt: new Date(), authorize: async () => {} });
    const opts = { source: "assignment" as const, triggerDetail: "system" as const,
      payload: { issueId: task.issueId, wakeCommentId: commentId },
      contextSnapshot: { issueId: task.issueId, wakeCommentId: commentId },
      requestedByActorType: "user" as const, requestedByActorId: "fixture-user",
      durableChatRequest: request };
    expect(await heartbeat.wakeup(task.agentId, opts)).toBeNull();
    expect(await heartbeat.wakeup(task.agentId, opts)).toBeNull();
    const receipts = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status,
      reason: agentWakeupRequests.reason }).from(agentWakeupRequests);
    expect(receipts).toEqual([{ id: requestId, status: "skipped",
      reason: "paperclip_runner_issue_ineligible" }]);
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(0);
  }, 60_000);

  it("replays a previously admitted retry after the Task mode changes", async () => {
    const task = await seed("standard");
    const [source] = await db.insert(heartbeatRuns).values({ companyId: task.companyId, agentId: task.agentId,
      invocationSource: "on_demand", triggerDetail: "manual", status: "failed", responsibleUserId: "fixture-user",
      contextSnapshot: { issueId: task.issueId }, runtimeMode: "legacy", finishedAt: new Date(Date.now() - 60_000),
      resultJson: { startupCancellation: { beforeNativeSelection: true }, conversationContinuation: "continue_conversation_v1" },
    }).returning();
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: task.companyId, agentId: task.agentId,
      invocationSource: "on_demand", triggerDetail: "manual", status: "queued", responsibleUserId: "fixture-user",
      retryOfRunId: source!.id, contextSnapshot: { issueId: task.issueId, wakeReason: "retry_failed_run" },
    }).returning();
    await db.update(issues).set({ workMode: "skill_test" }).where(eq(issues.id, task.issueId!));
    const replayed = await heartbeat.wakeup(task.agentId, { source: "on_demand", triggerDetail: "manual",
      reason: "retry_failed_run", failedRunId: source!.id, requestedByActorType: "user",
      requestedByActorId: "fixture-user", payload: { issueId: task.issueId } });
    expect(replayed?.id).toBe(successor!.id);
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(2);
  }, 60_000);

  it("terminalizes only the bound pending reconciliation when its Task mode becomes ineligible", async () => {
    async function arrange(workMode: "standard" | "skill_test") {
      const task = await seed(workMode);
      const [sourceRun] = await db.insert(heartbeatRuns).values({ companyId: task.companyId,
        agentId: task.agentId, invocationSource: "on_demand", triggerDetail: "manual",
        status: "failed", responsibleUserId: "fixture-user", runtimeMode: "legacy",
        contextSnapshot: { issueId: task.issueId }, finishedAt: new Date(Date.now() - 60_000),
        resultJson: { startupCancellation: { beforeNativeSelection: true } },
      }).returning();
      const decision = { runId: sourceRun!.id, providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "Synthetic source run completed before this local admission test." };
      const [action] = await db.insert(issueRecoveryActions).values({ companyId: task.companyId,
        sourceIssueId: task.issueId!, kind: "active_run_watchdog", status: "resolved",
        ownerType: "board", returnOwnerAgentId: task.agentId,
        cause: "synthetic_source_failure", fingerprint: sourceRun!.id,
        nextAction: "Synthetic local reconciliation", evidence: {
          executionReconciliation: decision, continuationDelivery: "pending" },
      }).returning();
      const wake = () => heartbeat.wakeup(task.agentId, { source: "automation", triggerDetail: "system",
        reason: "issue_recovery_action_restored", idempotencyKey: `execution-reconciliation:${action!.id}`,
        payload: { issueId: task.issueId, recoveryActionId: action!.id },
        requestedByActorType: "system", requestedByActorId: "execution-recovery",
        contextSnapshot: { issueId: task.issueId, taskId: task.issueId, recoveryActionId: action!.id,
          previousRunId: sourceRun!.id, retryOfRunId: sourceRun!.id, forceFreshSession: true,
          wakeReason: "issue_recovery_action_restored", source: "execution.reconciled" },
      });
      return { task, sourceRun, action, wake };
    }

    const normal = await arrange("standard");
    const accepted = await normal.wake();
    expect(accepted).toMatchObject({ status: "queued" });
    const [normalAction] = await db.select({ evidence: issueRecoveryActions.evidence })
      .from(issueRecoveryActions).where(eq(issueRecoveryActions.id, normal.action!.id));
    expect(normalAction?.evidence.continuationDelivery).toBe("pending");

    const fault = await arrange("skill_test");
    const [unrelated] = await db.insert(issueRecoveryActions).values({ companyId: fault.task.companyId,
      sourceIssueId: fault.task.issueId!, kind: "active_run_watchdog", status: "resolved",
      ownerType: "board", returnOwnerAgentId: fault.task.agentId,
      cause: "unrelated_synthetic_failure", fingerprint: randomUUID(),
      nextAction: "Unrelated synthetic action", evidence: { continuationDelivery: "pending" },
    }).returning();
    expect(await fault.wake()).toBeNull();
    const actions = await db.select({ id: issueRecoveryActions.id, evidence: issueRecoveryActions.evidence })
      .from(issueRecoveryActions);
    expect(actions.find((entry) => entry.id === fault.action!.id)?.evidence).toMatchObject({
      continuationDelivery: "invalidated", continuationDeliveryReason: "paperclip_runner_issue_ineligible",
    });
    expect(actions.find((entry) => entry.id === unrelated!.id)?.evidence.continuationDelivery).toBe("pending");
    expect(actions.find((entry) => entry.id === normal.action!.id)?.evidence.continuationDelivery).toBe("pending");
    const runIds = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runIds).toHaveLength(3); // Both source Runs plus only the eligible successor.
    expect(await db.select({ reason: agentWakeupRequests.reason }).from(agentWakeupRequests))
      .toEqual(expect.arrayContaining([{ reason: "paperclip_runner_issue_ineligible" }]));

    await db.update(issues).set({ workMode: "skill_test" }).where(eq(issues.id, normal.task.issueId!));
    const replayed = await normal.wake();
    expect(replayed?.id).toBe(accepted?.id);
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(3);
  }, 60_000);

  it("preserves the direct adapter's unscoped wake", async () => {
    const direct = await seed(null, "claude_local");
    const directRun = await heartbeat.invoke(direct.agentId, "on_demand", {}, "manual", { actorType: "user", actorId: "fixture-user" });
    expect(directRun).toMatchObject({ status: "queued" });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toHaveLength(1);
  }, 60_000);
});
