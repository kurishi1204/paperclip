import { randomUUID } from "node:crypto";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, budgetPolicies, costEvents, environmentLeases, heartbeatRuns, issueExecutionDecisions, issues } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { createWakeQueue } from "../modules/wake-queue/index.js";
import { createAdmissionTransactionScope, createWakeAdmissionReader } from "../modules/wake-queue/adapters/postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { isAuthorizedQaDecisionWake, qaDecisionWakeBlocksDelivery } from "../services/qa-decision-wake.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import * as reviewProcesses from "@paperclipai/adapter-utils/server-utils";

describe("QA return fresh episode through real routes and PostgreSQL", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    server = await startRunnerApiTestServer();
    vi.stubEnv("PAPERCLIP_API_URL", server.apiUrl);
  }, 90_000);
  afterEach(async () => {
    await heartbeatService(server.db).drainActiveRunExecutions();
    for (const running of reviewProcesses.runningProcesses.values()) {
      running.closed = true;
      for (const cleanup of running.closeCleanups ?? []) cleanup();
    }
    reviewProcesses.runningProcesses.clear();
  });
  afterAll(async () => {
    if (server) await heartbeatService(server.db).drainActiveRunExecutions();
    await server?.close();
    vi.unstubAllEnvs();
  });

  function settleSyntheticReviewProcess(runId: string) {
    const running = reviewProcesses.runningProcesses.get(runId);
    if (!running) return;
    running.closed = true;
    for (const cleanup of running.closeCleanups ?? []) cleanup();
    reviewProcesses.runningProcesses.delete(runId);
  }

  async function reviewFixture() {
    // Reconciliation scans all companies. Reset this dedicated database for
    // each case so a prior case cannot supply another runnable Issue.
    const fixture = await server.fixture({ connectionScenario: "fresh", reset: true });
    const stageId = randomUUID();
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: fixture.agentId }] }],
    });
    await server.db.update(issues).set({
      status: "in_review",
      executionPolicy: policy,
      executionState: {
        status: "pending", currentStageId: stageId, currentStageIndex: 0,
        currentStageType: "review", currentParticipant: { type: "agent", agentId: fixture.agentId },
        returnAssignee: { type: "agent", agentId: fixture.agentId }, reviewRequest: null, completedStageIds: [],
        lastDecisionId: null, lastDecisionOutcome: null, monitor: null,
      },
    }).where(eq(issues.id, fixture.issueId));
    await server.db.update(heartbeatRuns).set({
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    const token = createLocalAgentJwt(fixture.agentId, fixture.companyId, "paperclip_runner", fixture.runId)!;
    // No OS process or provider is started by this review-only fixture.
    reviewProcesses.runningProcesses.set(fixture.runId, {
      child: { pid: 12345678, exitCode: null, signalCode: null, kill: vi.fn() } as never,
      graceSec: 10, processGroupId: null,
    });
    if ("bindQaReviewProcess" in reviewProcesses) reviewProcesses.bindQaReviewProcess(fixture.runId, 12345678);
    const call = async (method: string, params?: object) => {
      const response = await fetch(`${server.apiUrl}/api/mcp/qa-review`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      });
      const wire = await response.text();
      return { status: response.status, body: JSON.parse(wire), wireBytes: Buffer.byteLength(wire, "utf8") };
    };
    const tool = (name: string, args: object = {}) => call("tools/call", { name, arguments: args });
    return { fixture, stageId, tool };
  }

  it("returns the committed capped decision without requesting an implementer episode", async () => {
    const { fixture, stageId, tool } = await reviewFixture();
    await server.db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.blockerId));
    await server.db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } })
      .where(eq(agents.id, fixture.agentId));
    const [implementer] = await server.db.insert(agents).values({
      companyId: fixture.companyId, name: "Capped return assignee", adapterType: "paperclip_runner", status: "active",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    }).returning();
    const policy = normalizeIssueExecutionPolicy({
      maxReviewRounds: 1,
      stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: fixture.agentId }] }],
    });
    const [before] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    await server.db.update(issues).set({ executionPolicy: policy, responsibleUserId: fixture.responsibleUserId,
      executionState: { ...(before!.executionState as Record<string, unknown>),
        returnAssignee: { type: "agent", agentId: implementer!.id },
      },
    }).where(eq(issues.id, fixture.issueId));
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const summary = "The first review requires human direction at this configured cap.";
    const result = await tool("submit_review_decision", {
      decision: "request_changes", summary, expectedStageId: stageId,
      expectedStatusVersion: issue.statusVersion, expectedRevision: issue.revision,
      expectedLastDecisionId: issue.reviewStage.lastDecisionId,
    });
    expect(result.body.result.isError).not.toBe(true);
    expect(result.body.result.structuredContent).toMatchObject({
      status: "in_review", decisionOutcome: "changes_requested",
      executionState: { status: "pending", changesRequestedCount: 1,
        currentParticipant: { type: "user", userId: fixture.responsibleUserId },
        lastDecisionOutcome: "changes_requested",
      },
    });
    const decisions = await server.db.select().from(issueExecutionDecisions)
      .where(and(eq(issueExecutionDecisions.companyId, fixture.companyId),
        eq(issueExecutionDecisions.issueId, fixture.issueId)));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      id: result.body.result.structuredContent.decisionId,
      outcome: "changes_requested", freshEpisodeWakeRequested: false, createdByRunId: fixture.runId,
    });
    const [held] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(held).toMatchObject({ status: "in_review", assigneeAgentId: null,
      assigneeUserId: fixture.responsibleUserId,
      executionState: { lastDecisionId: decisions[0]!.id, lastDecisionOutcome: "changes_requested" },
    });
    expect((await tool("read_assigned_review_receipt", {
      expectedStageId: stageId, decision: "request_changes", summary,
    })).body.result.structuredContent).toMatchObject({
      recorded: true, decisionId: decisions[0]!.id, decisionOutcome: "changes_requested",
    });
    expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, fixture.companyId))).toEqual([]);
    expect(await server.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixture.companyId))).toEqual([{ id: fixture.runId }]);
  });

  it("recovers a request-changes receipt after assignment returns to another agent", async () => {
    const { fixture, stageId, tool } = await reviewFixture();
    // The fixture also creates a separate assigned dependency issue. Keep it
    // out of the broad reconciliation below so no real provider can start.
    await server.db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.blockerId));
    // This test covers the returned implementer episode. A second QA provider
    // turn is outside its scope after the stub resubmits the issue for review.
    await server.db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } })
      .where(eq(agents.id, fixture.agentId));
    const adapterType = `qa_return_stub_${randomUUID().replaceAll("-", "")}`;
    let implementerId: string | null = null;
    const execute = vi.fn<ServerAdapterModule["execute"]>(async (ctx) => {
      if (ctx.agent.id !== implementerId || ctx.context.issueId !== fixture.issueId) {
        throw new Error("Unexpected provider dispatch in QA return fixture");
      }
      const [current] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
      if (!current?.executionPolicy) throw new Error("QA return fixture lost its execution policy");
      const transition = applyIssueExecutionPolicyTransition({
        issue: current, policy: current.executionPolicy, previousPolicy: current.executionPolicy,
        requestedStatus: "in_review", requestedAssigneePatch: {},
        actor: { agentId: implementerId, userId: null },
        commentBody: "Synthetic source evidence is ready for QA review.",
      });
      await server.db.update(issues).set({ ...transition.patch,
        revision: current.revision + 1, statusVersion: current.statusVersion + 1,
      }).where(eq(issues.id, fixture.issueId));
      return { exitCode: 0, signal: null, timedOut: false,
        summary: "Synthetic changes resubmitted for QA review" };
    });
    registerServerAdapter({ type: adapterType, execute,
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    onTestFinished(async () => {
      await heartbeatService(server.db).drainActiveRunExecutions();
      unregisterServerAdapter(adapterType);
    });
    const [lockedBefore] = await server.db.select({ executionRunId: issues.executionRunId })
      .from(issues).where(eq(issues.id, fixture.issueId));
    expect(lockedBefore!.executionRunId).toBe(fixture.runId);
    const [implementer] = await server.db.insert(agents).values({
      companyId: fixture.companyId, name: "Implementer", adapterType, status: "active",
    }).returning();
    implementerId = implementer!.id;
    await server.db.update(issues).set({ executionState: {
      status: "pending", currentStageId: stageId, currentStageIndex: 0,
      currentStageType: "review", currentParticipant: { type: "agent", agentId: fixture.agentId },
      returnAssignee: { type: "agent", agentId: implementer!.id }, reviewRequest: null,
      completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, monitor: null,
    } }).where(eq(issues.id, fixture.issueId));
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const summary = "Please add the missing source evidence.";
    expect((await tool("submit_review_decision", {
      decision: "request_changes", summary, expectedStageId: stageId,
      expectedStatusVersion: issue.statusVersion, expectedRevision: issue.revision,
      expectedLastDecisionId: issue.reviewStage.lastDecisionId,
    })).body.result.isError).not.toBe(true);
    const [returned] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(returned!.assigneeAgentId).toBe(implementer!.id);
    expect(returned!.executionRunId).toBeNull();
    const [committed] = await server.db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, fixture.issueId));
    expect(committed).toMatchObject({ outcome: "changes_requested", freshEpisodeWakeRequested: true });
    const [qaRun] = await server.db.select({ status: heartbeatRuns.status })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(qaRun!.status).toBe("running");
    // The QA subprocess is still running so the implementer wake is durable
    // and deferred until its execution lease settles.
    await expect.poll(() => server.db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, implementer!.id)), {
      timeout: 10_000,
    }).toEqual([expect.objectContaining({ status: "deferred_issue_execution" })]);
    const [deferred] = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, implementer!.id));
    expect(deferred!.idempotencyKey).toBe(`qa-decision:${committed!.id}`);
    expect(deferred!.coalescedCount).toBe(0);
    expect((await tool("read_assigned_review_receipt", {
      expectedStageId: stageId, decision: "request_changes", summary,
    })).body.result.structuredContent).toMatchObject({ recorded: true, decisionOutcome: "changes_requested" });
    // The returned implementer must actually receive a run when QA exits.
    // A durable deferred receipt alone does not complete the handoff.
    await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.runId));
    settleSyntheticReviewProcess(fixture.runId);
    const releasedByCleanup = await createWakeQueue(server.db, {
      resolveResponsibleUserId: async () => fixture.responsibleUserId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: {} as never,
      recovery: {
        escalateStrandedAssignedIssue: async () => {},
        escalateStrandedRecoveryIssueInPlace: async () => {},
      },
    }).releaseIssueExecution({ companyId: fixture.companyId, runId: fixture.runId, now: new Date() });
    expect(releasedByCleanup.outcome.kind).toBe("promoted");
    const [released] = await server.db.select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, implementer!.id));
    expect(released?.status).not.toBe("deferred_issue_execution");
    expect(released?.runId).toBeTruthy();
    const [implementerRun] = await server.db.select()
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, released!.runId!));
    expect(implementerRun?.agentId).toBe(implementer!.id);
    expect(implementerRun?.contextSnapshot).toMatchObject({
      qaDecisionId: committed!.id, forceFreshSession: true,
    });
    expect(implementerRun?.id).not.toBe(fixture.runId);

    // Keep the route, PostgreSQL wake queue, and claim real. Only provider
    // execution is stubbed, and its adapter was bound before decision commit.
    const heartbeat = heartbeatService(server.db);
    const currentQaAuthority = () => isAuthorizedQaDecisionWake(server.db, {
      companyId: fixture.companyId, issueId: fixture.issueId,
      agentId: implementer!.id, decisionId: committed!.id,
    });
    expect(await currentQaAuthority()).toBe(true);
    await heartbeat.reconcileStrandedAssignedIssues();
    expect(await currentQaAuthority()).toBe(true);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const [claimed] = await server.db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, implementerRun!.id));
    expect(claimed?.startedAt).not.toBeNull();
    expect(claimed?.status).toBe("succeeded");
    expect(claimed?.runnerProfileJson).toMatchObject({ adapterDispatch: { adapterType } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.map(([ctx]) => ctx.runId)).toEqual([implementerRun!.id]);
    const [resubmitted] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(resubmitted).toMatchObject({ status: "in_review", assigneeAgentId: fixture.agentId });
    expect(resubmitted!.executionState).toMatchObject({ status: "pending", currentStageId: stageId });
    await heartbeatService(server.db).resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, fixture.companyId),
        eq(agentWakeupRequests.idempotencyKey, `qa-decision:${committed!.id}`))))
      .toHaveLength(1);
    const newIssueRuns = await server.db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, fixture.companyId),
        sql`${heartbeatRuns.id} <> ${fixture.runId}::uuid`,
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${fixture.issueId}`));
    expect(newIssueRuns).toEqual([{ id: implementerRun!.id, agentId: implementer!.id }]);
  });

  it("recovers one deferred QA decision after an acknowledged review stop", async () => {
    const { fixture, stageId, tool } = await reviewFixture();
    await server.db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.blockerId));
    await server.db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } })
      .where(eq(agents.id, fixture.agentId));
    const adapterType = `qa_stopped_return_stub_${randomUUID().replaceAll("-", "")}`;
    let implementerId: string | null = null;
    const execute = vi.fn<ServerAdapterModule["execute"]>(async (ctx) => {
      if (ctx.agent.id !== implementerId || ctx.context.issueId !== fixture.issueId) {
        throw new Error("Unexpected provider dispatch in stopped QA return fixture");
      }
      const [current] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
      if (!current?.executionPolicy) throw new Error("Stopped QA return fixture lost its execution policy");
      const transition = applyIssueExecutionPolicyTransition({
        issue: current, policy: current.executionPolicy, previousPolicy: current.executionPolicy,
        requestedStatus: "in_review", requestedAssigneePatch: {},
        actor: { agentId: implementerId, userId: null },
        commentBody: "Synthetic revision after the review stop is ready for QA.",
      });
      await server.db.update(issues).set({ ...transition.patch,
        revision: current.revision + 1, statusVersion: current.statusVersion + 1,
      }).where(eq(issues.id, fixture.issueId));
      return { exitCode: 0, signal: null, timedOut: false,
        summary: "Synthetic changes resubmitted after the review stopped" };
    });
    registerServerAdapter({ type: adapterType, execute,
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    onTestFinished(async () => {
      await heartbeatService(server.db).drainActiveRunExecutions();
      unregisterServerAdapter(adapterType);
    });
    const [implementer] = await server.db.insert(agents).values({
      companyId: fixture.companyId, name: "Implementer after QA stop", adapterType, status: "active",
    }).returning();
    implementerId = implementer!.id;
    const [before] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    await server.db.update(issues).set({ executionState: {
      ...(before!.executionState as Record<string, unknown>),
      returnAssignee: { type: "agent", agentId: implementerId },
    } }).where(eq(issues.id, fixture.issueId));
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const verdict = await tool("submit_review_decision", {
      decision: "request_changes", summary: "Please supply the missing verification before resubmitting.",
      expectedStageId: stageId, expectedStatusVersion: issue.statusVersion,
      expectedRevision: issue.revision, expectedLastDecisionId: issue.reviewStage.lastDecisionId,
    });
    expect(verdict.body.result.isError).not.toBe(true);
    const decisionId = verdict.body.result.structuredContent.decisionId;
    await expect.poll(() => server.db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, fixture.companyId),
        eq(agentWakeupRequests.agentId, implementerId!))), { timeout: 10_000 })
      .toEqual([expect.objectContaining({ status: "deferred_issue_execution", runId: null,
        idempotencyKey: `qa-decision:${decisionId}` })]);
    const [deferred] = await server.db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, fixture.companyId),
        eq(agentWakeupRequests.agentId, implementerId!)));
    expect(deferred!.coalescedCount).toBe(0);
    const [returned] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(returned).toMatchObject({ status: "in_progress", assigneeAgentId: implementerId,
      executionState: { status: "changes_requested", lastDecisionId: decisionId } });

    // Model an acknowledged stop after the verdict, without running a real
    // provider or the normal cleanup that would drain this durable receipt.
    const stoppedAt = new Date();
    await server.db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: stoppedAt,
      resultJson: { executionCancellation: { state: "acknowledged", acknowledgedAt: stoppedAt.toISOString() } },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    const stoppedProcess = reviewProcesses.runningProcesses.get(fixture.runId)!;
    stoppedProcess.closed = true;
    for (const cleanup of stoppedProcess.closeCleanups ?? []) cleanup();
    reviewProcesses.runningProcesses.delete(fixture.runId);
    const [stopped] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    const [lease] = await server.db.insert(environmentLeases).values({
      companyId: fixture.companyId, issueId: fixture.issueId, heartbeatRunId: fixture.runId,
      status: "active", leasePolicy: "ephemeral", provider: "local", metadata: { driver: "local" },
    }).returning();
    await server.db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 31_000) })
      .where(eq(agentWakeupRequests.id, deferred!.id));
    const heartbeat = heartbeatService(server.db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).not.toHaveBeenCalled();
    const [heldReceipt] = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferred!.id));
    expect(heldReceipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(await server.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixture.companyId))).toEqual([{ id: fixture.runId }]);
    // Only this disposable lease's synthetic completion changes. There is no
    // provider process to stop, and the old run and decision remain intact.
    await server.db.update(environmentLeases).set({ status: "released", releasedAt: new Date(),
      cleanupStatus: "success", updatedAt: new Date(),
    }).where(eq(environmentLeases.id, lease!.id));
    await server.db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 31_000) })
      .where(eq(agentWakeupRequests.id, deferred!.id));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const [consumed] = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferred!.id));
    expect(consumed).toMatchObject({ status: "completed", payload: deferred!.payload,
      idempotencyKey: deferred!.idempotencyKey, coalescedCount: 0 });
    expect(consumed!.runId).toBeTruthy();
    expect(consumed!.runId).not.toBe(fixture.runId);
    const [newRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, consumed!.runId!));
    expect(newRun).toMatchObject({ agentId: implementerId, status: "succeeded",
      sessionIdBefore: null, contextSnapshot: { qaDecisionId: decisionId, forceFreshSession: true } });
    expect(newRun!.startedAt).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.map(([ctx]) => ctx.runId)).toEqual([newRun!.id]);
    const [delivery] = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, newRun!.wakeupRequestId!));
    expect(delivery).toMatchObject({ status: "completed", runId: newRun!.id,
      idempotencyKey: `qa-decision:${decisionId}` });
    expect(delivery!.id).toBe(deferred!.id);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalledTimes(1);
    const [oldRunAfter] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(oldRunAfter).toMatchObject({ id: stopped!.id, status: stopped!.status,
      startedAt: stopped!.startedAt, finishedAt: stopped!.finishedAt, resultJson: stopped!.resultJson });
    expect(await server.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixture.companyId)))
      .toEqual(expect.arrayContaining([{ id: fixture.runId }, { id: newRun!.id }]));
    expect(await server.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixture.companyId))).toHaveLength(2);
    expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, fixture.companyId),
        eq(agentWakeupRequests.idempotencyKey, `qa-decision:${decisionId}`))))
      .toEqual([{ id: deferred!.id }]);
  });

  it.each(["decision", "stage", "assignee"] as const)(
    "settles a queued QA return when its %s authority is superseded",
    async (invalidated) => {
      const { fixture, stageId, tool } = await reviewFixture();
      const [implementer] = await server.db.insert(agents).values({
        companyId: fixture.companyId, name: "Return assignee", adapterType: "paperclip_runner", status: "active",
      }).returning();
      const [before] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
      await server.db.update(issues).set({ executionState: {
        ...(before!.executionState as Record<string, unknown>),
        returnAssignee: { type: "agent", agentId: implementer!.id },
      } }).where(eq(issues.id, fixture.issueId));
      const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
      expect((await tool("submit_review_decision", {
        decision: "request_changes", summary: "Revise the source evidence.", expectedStageId: stageId,
        expectedStatusVersion: issue.statusVersion, expectedRevision: issue.revision,
        expectedLastDecisionId: issue.reviewStage.lastDecisionId,
      })).body.result.isError).not.toBe(true);
      await expect.poll(() => server.db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, implementer!.id)), { timeout: 10_000 })
        .toEqual([expect.objectContaining({ status: "deferred_issue_execution" })]);
      await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, fixture.runId));
      settleSyntheticReviewProcess(fixture.runId);
      const release = await createWakeQueue(server.db, {
        resolveResponsibleUserId: async () => fixture.responsibleUserId,
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
        wakeAdmissionHelpers: {} as never,
        recovery: {
          escalateStrandedAssignedIssue: async () => {},
          escalateStrandedRecoveryIssueInPlace: async () => {},
        },
      }).releaseIssueExecution({ companyId: fixture.companyId, runId: fixture.runId, now: new Date() });
      expect(release.outcome.kind).toBe("promoted");
      const [wake] = await server.db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, implementer!.id));
      const [current] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
      const state = current!.executionState as Record<string, unknown>;
      await server.db.update(issues).set(invalidated === "assignee"
        ? { assigneeAgentId: fixture.agentId }
        : { executionState: { ...state,
          [invalidated === "decision" ? "lastDecisionId" : "currentStageId"]: randomUUID(),
        } }).where(eq(issues.id, fixture.issueId));
      const heartbeat = heartbeatService(server.db);
      await heartbeat.resumeQueuedRuns();
      const [stale] = await server.db.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wake!.runId!));
      expect(stale).toMatchObject({ status: "cancelled", errorCode:
        invalidated === "assignee" ? "issue_assignee_changed" : "queued_run_claim_rejected" });
      expect(stale!.startedAt).toBeNull();
      // A new service instance models startup recovery against the persisted
      // row; a stale authority must not stay queued for every later scan.
      await heartbeatService(server.db).resumeQueuedRuns();
      const [stillStale] = await server.db.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wake!.runId!));
      expect(stillStale!.status).toBe("cancelled");
      expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, wake!.idempotencyKey!))).toHaveLength(1);
    },
  );

  it("finds ordinary deferred work behind dedicated QA receipts in PostgreSQL", async () => {
    const fixture = await server.fixture({ connectionScenario: "fresh", reset: true });
    const old = new Date(Date.now() - 60_000);
    await server.db.insert(agentWakeupRequests).values([
      { payload: { issueId: fixture.issueId, qaDecisionId: randomUUID() } },
      { payload: { issueId: fixture.issueId, _paperclipWakeContext: { qaDecisionId: randomUUID() } } },
      { payload: { issueId: fixture.issueId }, idempotencyKey: `qa-decision:${randomUUID()}` },
    ].map(input => ({ ...input, companyId: fixture.companyId, agentId: fixture.agentId,
      source: "assignment", status: "deferred_issue_execution", requestedAt: old })));
    const [ordinary] = await server.db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId, agentId: fixture.agentId, source: "assignment",
      status: "deferred_issue_execution", payload: { issueId: fixture.issueId },
    }).returning();
    const found = await server.db.transaction(tx => createWakeAdmissionReader().findExistingDeferredWake(
      createAdmissionTransactionScope(fixture.companyId, tx as never), {
        companyId: fixture.companyId, agentId: fixture.agentId, issueId: fixture.issueId,
      }));
    expect(found?.id).toBe(ordinary!.id);
    const all = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, fixture.companyId));
    expect(all).toHaveLength(4);
    expect(all.every(row => row.status === "deferred_issue_execution" && row.runId === null)).toBe(true);
  });

  it("lets only proven prestart terminal QA receipts release the decision key", async () => {
    const { fixture, stageId, tool } = await reviewFixture();
    await server.db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.blockerId));
    await server.db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } })
      .where(eq(agents.id, fixture.agentId));
    const [implementer] = await server.db.insert(agents).values({
      companyId: fixture.companyId, name: "Prestart return assignee", adapterType: "paperclip_runner",
      status: "active", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    }).returning();
    const [before] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    await server.db.update(issues).set({ executionState: {
      ...(before!.executionState as Record<string, unknown>),
      returnAssignee: { type: "agent", agentId: implementer!.id },
    } }).where(eq(issues.id, fixture.issueId));
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const verdict = await tool("submit_review_decision", {
      decision: "request_changes", summary: "Synthetic QA return for prestart receipt classification.",
      expectedStageId: stageId, expectedStatusVersion: issue.statusVersion,
      expectedRevision: issue.revision, expectedLastDecisionId: issue.reviewStage.lastDecisionId,
    });
    expect(verdict.body.result.isError).not.toBe(true);
    const decisionId = verdict.body.result.structuredContent.decisionId as string;
    expect(await server.db.select({ id: issueExecutionDecisions.id }).from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.id, decisionId))).toHaveLength(1);
    const key = `qa-decision:${decisionId}`;
    await expect.poll(() => server.db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, fixture.companyId), eq(agentWakeupRequests.idempotencyKey, key),
    )), { timeout: 10_000 }).toEqual([expect.objectContaining({ status: "deferred_issue_execution", runId: null })]);
    const [routeWake] = await server.db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, fixture.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
    const finishedAt = new Date();
    await server.db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt })
      .where(eq(agentWakeupRequests.id, routeWake!.id));

    const addWake = async (status: string, patch: Partial<typeof agentWakeupRequests.$inferInsert> = {}) => {
      const [wake] = await server.db.insert(agentWakeupRequests).values({
        companyId: fixture.companyId, agentId: implementer!.id, source: "assignment",
        triggerDetail: "system", reason: "execution_changes_requested", payload: { issueId: fixture.issueId },
        idempotencyKey: key, status, finishedAt, ...patch,
      }).returning();
      return wake!;
    };
    const addRun = async (wakeId: string, status: string, patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) => {
      const [run] = await server.db.insert(heartbeatRuns).values({
        companyId: fixture.companyId, agentId: implementer!.id, invocationSource: "assignment",
        triggerDetail: "system", status, wakeupRequestId: wakeId,
        contextSnapshot: { issueId: fixture.issueId, qaDecisionId: decisionId }, ...patch,
      }).returning();
      return run!;
    };
    const failedRunless = await addWake("failed");
    const prestart = await addWake("cancelled");
    const prestartRun = await addRun(prestart.id, "cancelled", { finishedAt });
    await server.db.update(agentWakeupRequests).set({ runId: prestartRun.id })
      .where(eq(agentWakeupRequests.id, prestart.id));
    const started = await addWake("cancelled");
    const startedRun = await addRun(started.id, "cancelled", { startedAt: finishedAt, finishedAt });
    await server.db.update(agentWakeupRequests).set({ runId: startedRun.id })
      .where(eq(agentWakeupRequests.id, started.id));
    const claimed = await addWake("cancelled", { claimedAt: finishedAt });
    const missingLinked = await addWake("failed", { runId: randomUUID() });
    const otherBackref = await addWake("cancelled");
    await addRun(otherBackref.id, "cancelled", { finishedAt });
    const unknown = await addWake("failed");
    // A terminal but inconsistent run is unknown; do not leave a queued fake
    // run that a background recovery could attempt to dispatch at teardown.
    const unknownRun = await addRun(unknown.id, "succeeded", { finishedAt });
    await server.db.update(agentWakeupRequests).set({ runId: unknownRun.id })
      .where(eq(agentWakeupRequests.id, unknown.id));
    const processEvidence = await addWake("failed");
    const processRun = await addRun(processEvidence.id, "failed", {
      finishedAt, processStartedAt: finishedAt, processPid: 12345,
    });
    await server.db.update(agentWakeupRequests).set({ runId: processRun.id })
      .where(eq(agentWakeupRequests.id, processEvidence.id));
    const ambiguous = await addWake("cancelled");
    const primary = await addRun(ambiguous.id, "cancelled", { finishedAt });
    await addRun(ambiguous.id, "cancelled", { finishedAt });
    await server.db.update(agentWakeupRequests).set({ runId: primary.id })
      .where(eq(agentWakeupRequests.id, ambiguous.id));

    const oldPredicate = await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, fixture.companyId),
        eq(agentWakeupRequests.idempotencyKey, key), sql`${agentWakeupRequests.status} <> 'skipped'`));
    const blocked = await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, fixture.companyId),
        eq(agentWakeupRequests.idempotencyKey, key), sql`${agentWakeupRequests.status} <> 'skipped'`,
        qaDecisionWakeBlocksDelivery()));
    const oldIds = new Set(oldPredicate.map(row => row.id));
    const blockedIds = new Set(blocked.map(row => row.id));
    const retryable = [routeWake!.id, failedRunless.id, prestart.id];
    const held = [started.id, claimed.id, missingLinked.id, otherBackref.id,
      unknown.id, processEvidence.id, ambiguous.id];
    expect(oldIds.size).toBe(retryable.length + held.length);
    for (const id of retryable) {
      expect(oldIds.has(id)).toBe(true); // Previous status-only gate lost this delivery.
      expect(blockedIds.has(id)).toBe(false);
    }
    for (const id of held) expect(blockedIds.has(id)).toBe(true);
    expect(blockedIds.size).toBe(held.length);
  });

  it("continues later QA candidates and normal recovery after a blocked candidate", async () => {
    const fixture = await server.fixture({ connectionScenario: "fresh", reset: true });
    await server.db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.blockerId));
    const [blockedAgent, laterAgent] = await server.db.insert(agents).values([
      { companyId: fixture.companyId, name: "Budget blocked QA assignee", adapterType: "paperclip_runner",
        status: "active", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } },
      { companyId: fixture.companyId, name: "Later QA assignee", adapterType: "paperclip_runner",
        status: "active", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } },
    ]).returning();
    const oldUpdatedAt = new Date(Date.now() - 120_000);
    const laterUpdatedAt = new Date(Date.now() - 60_000);
    const seeds = [
      { agent: blockedAgent!, updatedAt: oldUpdatedAt, title: "Earlier blocked QA", issueId: randomUUID(),
        stageId: randomUUID(), decisionId: randomUUID() },
      { agent: laterAgent!, updatedAt: laterUpdatedAt, title: "Later recoverable QA", issueId: randomUUID(),
        stageId: randomUUID(), decisionId: randomUUID() },
    ];
    for (const seed of seeds) {
      await server.db.insert(issues).values({
        id: seed.issueId, companyId: fixture.companyId, projectId: fixture.projectId,
        title: seed.title, status: "in_progress", assigneeAgentId: seed.agent.id,
        responsibleUserId: fixture.responsibleUserId, updatedAt: seed.updatedAt,
        executionState: { status: "changes_requested", currentStageId: seed.stageId,
          lastDecisionId: seed.decisionId, returnAssignee: { type: "agent", agentId: seed.agent.id } },
      });
      await server.db.insert(issueExecutionDecisions).values({
        id: seed.decisionId, companyId: fixture.companyId, issueId: seed.issueId,
        stageId: seed.stageId, stageType: "review", outcome: "changes_requested",
        freshEpisodeWakeRequested: true, body: "Synthetic committed review decision",
      });
      // Keep generic stranded-work recovery from dispatching a provider. QA
      // admission still reaches the budget/wakeOnDemand gates before its lock.
      await server.db.insert(heartbeatRuns).values({
        companyId: fixture.companyId, agentId: seed.agent.id, status: "running",
        invocationSource: "assignment", triggerDetail: "system",
        contextSnapshot: { issueId: seed.issueId },
      });
    }
    expect(seeds[0]!.updatedAt.getTime()).toBeLessThan(seeds[1]!.updatedAt.getTime());
    await server.db.insert(budgetPolicies).values({
      companyId: fixture.companyId, scopeType: "agent", scopeId: blockedAgent!.id,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 1,
      hardStopEnabled: true, isActive: true,
    });
    await server.db.insert(costEvents).values({
      companyId: fixture.companyId, agentId: blockedAgent!.id, issueId: seeds[0]!.issueId,
      provider: "test", biller: "test", billingType: "tokens", model: "test-model",
      costCents: 1, occurredAt: new Date(),
    });

    const heartbeat = heartbeatService(server.db);
    const first = await heartbeat.reconcileStrandedAssignedIssues();
    // Returning the normal recovery result proves the candidate exception did
    // not abort that phase. The later candidate is also processed this pass.
    expect(first).toHaveProperty("assignmentDispatched");
    expect(first.skipped).toBeGreaterThanOrEqual(2);
    const qaIssues = await server.db.select({ id: issues.id, status: issues.status }).from(issues)
      .where(sql`${issues.id} in (${seeds[0]!.issueId}::uuid, ${seeds[1]!.issueId}::uuid)`);
    expect(qaIssues).toEqual(expect.arrayContaining([
      { id: seeds[0]!.issueId, status: "in_progress" },
      { id: seeds[1]!.issueId, status: "in_progress" },
    ]));
    const [budgetWait] = await server.db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, blockedAgent!.id), eq(agentWakeupRequests.reason, "budget.blocked")));
    const [laterSkip] = await server.db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, laterAgent!.id),
      eq(agentWakeupRequests.reason, "heartbeat.wakeOnDemand.disabled")));
    expect(budgetWait).toMatchObject({ status: "skipped", payload: {
      issueId: seeds[0]!.issueId, executionWait: { requestedIdempotencyKey: `qa-decision:${seeds[0]!.decisionId}` },
    } });
    expect(laterSkip).toMatchObject({ status: "skipped", payload: {
      issueId: seeds[1]!.issueId, executionWait: { requestedIdempotencyKey: `qa-decision:${seeds[1]!.decisionId}` },
    } });
    const beforeRetry = [budgetWait!.coalescedCount, laterSkip!.coalescedCount];
    const second = await heartbeat.reconcileStrandedAssignedIssues();
    expect(second).toHaveProperty("assignmentDispatched");
    const [budgetWaitAgain] = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, budgetWait!.id));
    const [laterSkipAgain] = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, laterSkip!.id));
    expect([budgetWaitAgain!.coalescedCount, laterSkipAgain!.coalescedCount]).toEqual(beforeRetry);
    expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, fixture.companyId),
        sql`${agentWakeupRequests.payload}->'executionWait'->>'requestedIdempotencyKey' = ${`qa-decision:${seeds[1]!.decisionId}`}`)))
      .toEqual([{ id: laterSkip!.id }]);
  });

});
