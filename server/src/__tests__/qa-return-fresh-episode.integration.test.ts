import { randomUUID } from "node:crypto";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issueExecutionDecisions, issues } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { createWakeQueue } from "../modules/wake-queue/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { isAuthorizedQaDecisionWake } from "../services/qa-decision-wake.js";
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

});
