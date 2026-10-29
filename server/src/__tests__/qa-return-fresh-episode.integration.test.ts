import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, budgetPolicies, costEvents, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueComments, issueExecutionDecisions, issueRecoveryActions, issues } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { createWakeQueue } from "../modules/wake-queue/index.js";
import { createAdmissionTransactionScope, createWakeAdmissionReader } from "../modules/wake-queue/adapters/postgres.js";
import { heartbeatService, persistHeartbeatRunProcessMetadata } from "../services/heartbeat.js";
import { agentService } from "../services/agents.js";
import { adapterExecutionControls } from "../services/adapter-execution-control.js";
import { getExecutionBlocker, getQaPredecessorWaitBlocker } from "../services/execution-blocker.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { isAuthorizedQaDecisionWake, qaDecisionWakeBlocksDelivery } from "../services/qa-decision-wake.js";
import { SELF_TASK_DOCUMENT_CONTEXT_KEY } from "../services/self-task-document-runtime.js";
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
      executionPolicy: policy ? { ...policy } : null,
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

  async function returnedQaFixture() {
    const { fixture, stageId, tool } = await reviewFixture();
    await server.db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.blockerId));
    await server.db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } })
      .where(eq(agents.id, fixture.agentId));
    const adapterType = `qa_preprovider_stub_${randomUUID().replaceAll("-", "")}`;
    let implementerId = "";
    const execute = vi.fn<ServerAdapterModule["execute"]>(async ctx => {
      if (ctx.agent.id !== implementerId || ctx.context.issueId !== fixture.issueId) {
        throw new Error("Unexpected provider dispatch in QA pre-provider fixture");
      }
      const [current] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
      const policy = normalizeIssueExecutionPolicy(current?.executionPolicy);
      if (!current || !policy) throw new Error("QA pre-provider fixture lost its policy");
      const transition = applyIssueExecutionPolicyTransition({
        issue: current, policy, previousPolicy: policy,
        requestedStatus: "in_review", requestedAssigneePatch: {},
        actor: { agentId: implementerId, userId: null },
        commentBody: "Synthetic pre-provider recovery is ready for review.",
      });
      await server.db.update(issues).set({ ...transition.patch,
        revision: current.revision + 1, statusVersion: current.statusVersion + 1,
      }).where(eq(issues.id, fixture.issueId));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Synthetic QA revision resubmitted" };
    });
    registerServerAdapter({ type: adapterType, execute,
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    onTestFinished(async () => {
      await heartbeatService(server.db).drainActiveRunExecutions();
      unregisterServerAdapter(adapterType);
    });
    const [implementer] = await server.db.insert(agents).values({
      companyId: fixture.companyId, name: "QA pre-provider return assignee", adapterType, status: "active",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    }).returning();
    implementerId = implementer!.id;
    const [before] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    await server.db.update(issues).set({ executionState: {
      ...(before!.executionState as Record<string, unknown>),
      returnAssignee: { type: "agent", agentId: implementerId },
    } }).where(eq(issues.id, fixture.issueId));
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const verdict = await tool("submit_review_decision", {
      decision: "request_changes", summary: "Complete the synthetic source verification.",
      expectedStageId: stageId, expectedStatusVersion: issue.statusVersion,
      expectedRevision: issue.revision, expectedLastDecisionId: issue.reviewStage.lastDecisionId,
    });
    expect(verdict.body.result.isError).not.toBe(true);
    const decisionId: string = verdict.body.result.structuredContent.decisionId;
    await expect.poll(() => server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, implementerId)), { timeout: 10_000 })
      .toEqual([expect.objectContaining({ status: "deferred_issue_execution", runId: null,
        idempotencyKey: `qa-decision:${decisionId}` })]);
    const [wake] = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, implementerId));
    const heartbeat = heartbeatService(server.db);
    const promote = async () => {
      await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, fixture.runId));
      settleSyntheticReviewProcess(fixture.runId);
      const released = await createWakeQueue(server.db, {
        resolveResponsibleUserId: async () => fixture.responsibleUserId,
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null, wakeAdmissionHelpers: {} as never,
        recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} },
      }).releaseIssueExecution({ companyId: fixture.companyId, runId: fixture.runId, now: new Date() });
      expect(released.outcome.kind).toBe("promoted");
      const [promoted] = await server.db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wake!.id));
      expect(promoted).toMatchObject({ status: "queued", reason: "issue_execution_promoted" });
      const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, promoted!.runId!));
      expect(run).toMatchObject({ status: "queued", agentId: implementerId,
        contextSnapshot: { qaDecisionId: decisionId, forceFreshSession: true } });
      return run!;
    };
    const genericWakes = () => server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, fixture.companyId),
        eq(agentWakeupRequests.reason, "issue_continuation_needed")));
    const issueDetail = async (runId: string) => {
      const token = createLocalAgentJwt(implementerId, fixture.companyId, adapterType, runId)!;
      const response = await fetch(`${server.apiUrl}/api/issues/${fixture.issueId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    return { fixture, implementerId, decisionId, wake: wake!, execute, heartbeat, promote, genericWakes, issueDetail };
  }

  async function ownedLocalProcess(withChild = false) {
    const program = withChild
      ? `const {spawn}=require('node:child_process');
         const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
         process.stdout.write(JSON.stringify({childPid:child.pid})+'\\n');setInterval(()=>{},1000);`
      : `process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", program], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "exit");
    const [wire] = await once(child.stdout!, "data");
    const childPid: number | null = withChild ? JSON.parse(String(wire)).childPid : null;
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      if (childPid) {
        try { process.kill(childPid, "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
      await expect.poll(() => {
        try { process.kill(-child.pid!, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }).toBe(true);
    };
    onTestFinished(stop);
    return { child, childPid, closed, stop };
  }

  it.skipIf(process.platform !== "darwin")("delivers one QA episode past a real later local PID=PGID generation without stopping that new group", async () => {
    const qa = await returnedQaFixture();
    const current = await ownedLocalProcess(true);
    const queued = await qa.promote();
    const recorded = await persistHeartbeatRunProcessMetadata(server.db, qa.fixture.runId, {
      pid: current.child.pid!, processGroupId: current.child.pid!, startedAt: new Date().toISOString(),
    });
    expect(recorded!.processPid).toBe(recorded!.processGroupId);
    expect(recorded!.processStartedAt).toBeInstanceOf(Date);
    // Real current child/group, synthetic historical ownership of the same
    // numbers. We do not force OS PID recycling or rewrite any real old Run.
    const now = Date.now();
    await server.db.update(heartbeatRuns).set({
      processStartedAt: new Date(now - 120_000), finishedAt: new Date(now - 60_000),
    }).where(eq(heartbeatRuns.id, qa.fixture.runId));
    const [source] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, qa.fixture.runId));
    const [decision] = await server.db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.id, qa.decisionId));
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    expect(qa.execute.mock.calls.map(([ctx]) => ctx.runId)).toEqual([queued.id]);
    expect((await qa.issueDetail(queued.id)).executionBlocker?.cause).not.toBe("qa_predecessor_ownership_active");
    expect(await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, qa.fixture.runId))).toEqual([source]);
    expect(await server.db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.id, qa.decisionId))).toEqual([decision]);
    expect(await qa.genericWakes()).toEqual([]);
    expect(() => process.kill(current.child.pid!, 0)).not.toThrow();
    expect(() => process.kill(current.childPid!, 0)).not.toThrow();
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    expect(qa.execute).toHaveBeenCalledTimes(1);
    await current.stop();
  });

  it.skipIf(process.platform !== "darwin")("holds a surviving real old group child even when the stored PID belongs to a later unrelated process", async () => {
    const qa = await returnedQaFixture();
    const old = await ownedLocalProcess(true);
    const replacement = await ownedLocalProcess();
    const queued = await qa.promote();
    await persistHeartbeatRunProcessMetadata(server.db, qa.fixture.runId, {
      pid: replacement.child.pid!, processGroupId: old.child.pid!, startedAt: new Date().toISOString(),
    });
    const now = Date.now();
    await server.db.update(heartbeatRuns).set({
      processStartedAt: new Date(now - 120_000), finishedAt: new Date(now - 60_000),
    }).where(eq(heartbeatRuns.id, qa.fixture.runId));
    // The old leader exits; its owned child keeps the old group alive. A
    // replacement PID alone must never erase that remaining ownership.
    old.child.kill("SIGTERM");
    await old.closed;
    expect(() => process.kill(old.childPid!, 0)).not.toThrow();
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    expect(qa.execute).not.toHaveBeenCalled();
    expect((await qa.issueDetail(queued.id)).executionBlocker).toMatchObject({
      cause: "qa_predecessor_ownership_active", runId: qa.fixture.runId,
    });
    expect(await qa.genericWakes()).toEqual([]);
    // End only this fixture's owned descendant, not the replacement process.
    await old.stop();
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    expect(qa.execute.mock.calls.map(([ctx]) => ctx.runId)).toEqual([queued.id]);
    expect(() => process.kill(replacement.child.pid!, 0)).not.toThrow();
    await replacement.stop();
  });

  it("shows the ownership hold on a promoted QA receipt and delivers it once after exact fixture cleanup", async () => {
    const qa = await returnedQaFixture();
    const [lease] = await server.db.insert(environmentLeases).values({
      companyId: qa.fixture.companyId, issueId: qa.fixture.issueId, heartbeatRunId: qa.fixture.runId,
      status: "pending_cleanup", leasePolicy: "ephemeral", provider: "local", metadata: { driver: "local" },
    }).returning();
    const queued = await qa.promote();
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    expect(qa.execute).not.toHaveBeenCalled();
    const [held] = await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, qa.wake.id));
    expect(held).toMatchObject({ status: "queued", runId: queued.id,
      payload: { executionWait: { reason: "qa_predecessor_ownership_active" } } });
    // The formal review decision is a historical issue comment. It must stay
    // intact; the empty input relevant to this notice is the wake's queued
    // comment list, not the issue's complete comment history.
    expect(await server.db.select({ authorAgentId: issueComments.authorAgentId }).from(issueComments)
      .where(eq(issueComments.issueId, qa.fixture.issueId)))
      .toEqual([{ authorAgentId: qa.fixture.agentId }]);
    const queuedContext = held!.payload?._paperclipWakeContext as Record<string, unknown> | undefined;
    expect(queuedContext === undefined || (queuedContext !== null &&
      typeof queuedContext === "object" && !Array.isArray(queuedContext))).toBe(true);
    expect(queuedContext?.wakeCommentIds ?? []).toEqual([]);
    expect((await qa.issueDetail(queued.id)).executionBlocker).toMatchObject({
      cause: "qa_predecessor_ownership_active", runId: qa.fixture.runId,
      agentId: qa.fixture.agentId, canRetry: false, canContinue: false,
    });
    const [locked] = await server.db.select().from(issues).where(eq(issues.id, qa.fixture.issueId));
    expect(locked!.executionRunId).toBe(queued.id);
    expect((await server.db.select().from(environmentLeases).where(eq(environmentLeases.id, lease!.id)))[0])
      .toEqual(lease);
    expect(await qa.genericWakes()).toEqual([]);
    // Settle only the lease created by this disposable fixture. No PID or
    // remote-termination evidence is invented to bypass the ownership hold.
    await server.db.update(environmentLeases).set({ status: "released", releasedAt: new Date(),
      cleanupStatus: "success", updatedAt: new Date(),
    }).where(eq(environmentLeases.id, lease!.id));
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    expect(qa.execute.mock.calls.map(([ctx]) => ctx.runId)).toEqual([queued.id]);
    const [completed] = await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, qa.wake.id));
    expect(completed).toMatchObject({ status: "completed", runId: queued.id, idempotencyKey: qa.wake.idempotencyKey });
    expect((await qa.issueDetail(queued.id)).executionBlocker?.cause).not.toBe("qa_predecessor_ownership_active");
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    expect(qa.execute).toHaveBeenCalledTimes(1);
    expect(await qa.genericWakes()).toEqual([]);
  });

  it("projects the current QA ownership hold before a runless receipt is promoted", async () => {
    const qa = await returnedQaFixture();
    const [lease] = await server.db.insert(environmentLeases).values({
      companyId: qa.fixture.companyId, issueId: qa.fixture.issueId, heartbeatRunId: qa.fixture.runId,
      status: "pending_cleanup", leasePolicy: "ephemeral", provider: "local", metadata: { driver: "local" },
    }).returning();
    await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, qa.fixture.runId));
    settleSyntheticReviewProcess(qa.fixture.runId);
    const [receiptBefore] = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, qa.wake.id));
    expect(receiptBefore).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(receiptBefore!.payload?.executionWait).toBeUndefined();
    expect(await server.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, qa.implementerId))).toEqual([]);
    const token = createLocalAgentJwt(qa.fixture.agentId, qa.fixture.companyId,
      "paperclip_runner", qa.fixture.runId)!;
    const readIssue = async () => {
      const response = await fetch(`${server.apiUrl}/api/issues/${qa.fixture.issueId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const [current] = await server.db.select().from(issues).where(eq(issues.id, qa.fixture.issueId));
    expect((await readIssue()).executionBlocker).toMatchObject({
      cause: "qa_predecessor_ownership_active", runId: qa.fixture.runId,
      agentId: qa.fixture.agentId, canRetry: false, canContinue: false,
    });
    // This is a read projection of current decision authority and physical
    // ownership. An old runless receipt or its diagnostic payload is not an
    // authority source and cannot show a hold for a different decision/stage.
    const state = current!.executionState as Record<string, unknown>;
    for (const changed of [
      { ...state, lastDecisionId: randomUUID() },
      { ...state, currentStageId: randomUUID() },
    ]) {
      await server.db.update(issues).set({ executionState: changed }).where(eq(issues.id, qa.fixture.issueId));
      expect((await readIssue()).executionBlocker?.cause).not.toBe("qa_predecessor_ownership_active");
    }
    await server.db.update(issues).set({ executionState: current!.executionState })
      .where(eq(issues.id, qa.fixture.issueId));
    expect((await readIssue()).executionBlocker?.cause).toBe("qa_predecessor_ownership_active");
    expect((await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, qa.wake.id)))[0]).toEqual(receiptBefore);
    expect((await server.db.select().from(environmentLeases).where(eq(environmentLeases.id, lease!.id)))[0])
      .toEqual(lease);
    await server.db.update(environmentLeases).set({ status: "released", releasedAt: new Date(),
      cleanupStatus: "success", updatedAt: new Date(),
    }).where(eq(environmentLeases.id, lease!.id));
    expect((await readIssue()).executionBlocker?.cause).not.toBe("qa_predecessor_ownership_active");
    expect(qa.execute).not.toHaveBeenCalled();
    expect(await qa.genericWakes()).toEqual([]);
  });

  it("clears a suppressed QA controller claim before a queued cancellation and redelivers once", async () => {
    const qa = await returnedQaFixture();
    const source = await qa.promote();
    const [decisionBefore] = await server.db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.id, qa.decisionId));
    const runtimeEnv: Record<string, string | undefined> = { PAPERCLIP_RESTORE_IN_PROGRESS: "0" };
    const heartbeat = heartbeatService(server.db, { runtimeEnv });
    let claimed = 0;
    const unsubscribe = subscribeCompanyLiveEvents(qa.fixture.companyId, event => {
      const value = event.payload as { runId?: string; status?: string };
      if (event.type === "heartbeat.run.status" && value.runId === source.id && value.status === "running") {
        claimed += 1;
        runtimeEnv.PAPERCLIP_RESTORE_IN_PROGRESS = "1";
      }
    });
    try {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
    } finally {
      unsubscribe();
    }
    expect(claimed).toBe(1);
    const [returned] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
    expect(returned).toMatchObject({ status: "queued", startedAt: null, responsibleUserId: null,
      controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null });
    expect((await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, qa.wake.id)))[0]).toMatchObject({ status: "queued", claimedAt: null });
    expect(qa.execute).not.toHaveBeenCalled();

    // Use the real claim gate for the next cancellation. Do not manually
    // erase boot IDs or mint a no-provider proof in the fixture.
    runtimeEnv.PAPERCLIP_RESTORE_IN_PROGRESS = "0";
    await server.db.update(agents).set({ runtimeConfig: {
      heartbeat: { enabled: false, wakeOnDemand: true, maxDailyRuns: 0 },
    } }).where(eq(agents.id, qa.implementerId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const [cancelled] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
    expect(cancelled).toMatchObject({ status: "cancelled", startedAt: null,
      controllerBootId: null, errorCode: "heartbeat.daily_run_limit" });
    expect((cancelled!.resultJson?.executionRecovery as Record<string, unknown> | undefined)?.qaPreProvider)
      .toBeUndefined();
    expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.id, qa.wake.id), qaDecisionWakeBlocksDelivery()))).toEqual([]);
    expect(qa.execute).not.toHaveBeenCalled();
    await server.db.update(agents).set({ runtimeConfig: {
      heartbeat: { enabled: false, wakeOnDemand: true },
    } }).where(eq(agents.id, qa.implementerId));
    // Advance only the disposable retry cursor past the existing five-minute
    // skipped backoff. The run, decision, claim and proof fields stay intact.
    await server.db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(agentWakeupRequests.id, qa.wake.id));
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(qa.execute).toHaveBeenCalledTimes(1);
    expect(qa.execute.mock.calls[0]![0]).toMatchObject({
      context: { qaDecisionId: qa.decisionId, forceFreshSession: true },
    });
    expect((await server.db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.id, qa.decisionId)))[0]).toEqual(decisionBefore);
    expect((await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id)))[0])
      .toEqual(cancelled);
    expect(await qa.genericWakes()).toEqual([]);
  }, 30_000);

  it.each(["running", "succeeded", "provider-failed"] as const)(
    "does not project a predecessor wait after the current QA decision is %s", async deliveredState => {
      const qa = await returnedQaFixture();
      await server.db.insert(environmentLeases).values({ companyId: qa.fixture.companyId,
        issueId: qa.fixture.issueId, heartbeatRunId: qa.fixture.runId,
        status: "pending_cleanup", leasePolicy: "ephemeral", provider: "local", metadata: { driver: "local" } });
      const source = await qa.promote();
      const readWait = () => getQaPredecessorWaitBlocker(server.db, qa.fixture.companyId, qa.fixture.issueId,
        () => qa.heartbeat.readQaPredecessorOwnershipHold(qa.fixture.companyId, qa.fixture.issueId));
      expect(await readWait()).toMatchObject({ cause: "qa_predecessor_ownership_active", runId: qa.fixture.runId });
      // Persisted delivery-state fixtures exercise the real DB reader. They
      // are not claims that this synthetic provider actually ran or failed.
      await server.db.update(heartbeatRuns).set({
        status: deliveredState === "provider-failed" ? "failed" : deliveredState,
        ...(deliveredState === "provider-failed" ? {
          resultJson: { executionRecovery: { providerWorkStarted: true } },
        } : {}),
      }).where(eq(heartbeatRuns.id, source.id));
      expect(await readWait()).toBeNull();
      // A run for a different decision cannot hide the pending current one.
      await server.db.update(heartbeatRuns).set({ contextSnapshot: {
        ...source.contextSnapshot, qaDecisionId: randomUUID(),
      } }).where(eq(heartbeatRuns.id, source.id));
      expect(await readWait()).toMatchObject({ cause: "qa_predecessor_ownership_active" });
      expect(qa.execute).not.toHaveBeenCalled();
    },
  );

  it("keeps an actionable recovery blocker ahead of an undelivered QA ownership notice", async () => {
    const qa = await returnedQaFixture();
    await server.db.insert(environmentLeases).values({ companyId: qa.fixture.companyId,
      issueId: qa.fixture.issueId, heartbeatRunId: qa.fixture.runId,
      status: "pending_cleanup", leasePolicy: "ephemeral", provider: "local", metadata: { driver: "local" } });
    const queued = await qa.promote();
    const [old] = await server.db.insert(heartbeatRuns).values({ companyId: qa.fixture.companyId,
      agentId: qa.implementerId, invocationSource: "assignment", triggerDetail: "system", status: "failed",
      contextSnapshot: { issueId: qa.fixture.issueId }, finishedAt: new Date(),
    }).returning();
    const [action] = await server.db.insert(issueRecoveryActions).values({
      companyId: qa.fixture.companyId, sourceIssueId: qa.fixture.issueId, kind: "active_run_watchdog",
      status: "resolved", ownerType: "board", cause: "uncertain_external_action",
      fingerprint: `synthetic-priority:${old!.id}`, resolvedAt: new Date(),
      evidence: { runId: old!.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      nextAction: "Inspect the preserved synthetic failure.",
    }).returning();
    const original = await getExecutionBlocker(server.db, qa.fixture.companyId, qa.fixture.issueId);
    expect(original).toMatchObject({ recoveryActionId: action!.id, runId: old!.id,
      cause: "uncertain_external_action", canRetry: true });
    expect(await getQaPredecessorWaitBlocker(server.db, qa.fixture.companyId, qa.fixture.issueId,
      () => qa.heartbeat.readQaPredecessorOwnershipHold(qa.fixture.companyId, qa.fixture.issueId)))
      .toMatchObject({ cause: "qa_predecessor_ownership_active" });
    expect((await qa.issueDetail(queued.id)).executionBlocker).toEqual(original);
    expect((await server.db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(action);
    expect(qa.execute).not.toHaveBeenCalled();
  });

  it("cancels a daily-capped QA claim without reentering the same agent start lock", async () => {
    const qa = await returnedQaFixture();
    const queued = await qa.promote();
    const [following] = await server.db.insert(agentWakeupRequests).values({
      companyId: qa.fixture.companyId, agentId: qa.implementerId, source: "assignment", triggerDetail: "system",
      reason: "issue_updated", payload: { issueId: qa.fixture.issueId, mutation: "update" },
      status: "deferred_issue_execution", idempotencyKey: `synthetic-following:${randomUUID()}`,
    }).returning();
    await server.db.update(agents).set({ runtimeConfig: {
      heartbeat: { enabled: false, wakeOnDemand: true, maxDailyRuns: 0 },
    } }).where(eq(agents.id, qa.implementerId));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        qa.heartbeat.resumeQueuedRuns().then(() => "settled"),
        new Promise<string>(resolve => { timeout = setTimeout(() => resolve("agent-start-lock-stalled"), 2_000); }),
      ]);
      expect(outcome).toBe("settled");
    } finally { if (timeout) clearTimeout(timeout); }
    await qa.heartbeat.drainActiveRunExecutions();
    const [cancelled] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
    expect(cancelled).toMatchObject({ status: "cancelled", startedAt: null, errorCode: "heartbeat.daily_run_limit" });
    expect(qa.execute).not.toHaveBeenCalled();
    const [promotedFollowing] = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, following!.id));
    expect(promotedFollowing!.runId).toBeTruthy();
    expect(promotedFollowing!.runId).not.toBe(queued.id);
    expect(await qa.genericWakes()).toEqual([]);
    // A later ordinary scan must also settle; the first cancellation must not
    // leave the shared lock poisoned or erase the distinct following input.
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    expect(qa.execute).not.toHaveBeenCalled();
    expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, following!.id))).toEqual([{ id: following!.id }]);
  });

  it("redelivers a proven pre-provider QA decision after its scheduled retry is suppressed", async () => {
    const qa = await returnedQaFixture();
    const source = await qa.promote();
    const terminalAt = new Date(Date.now() - 31_000);
    // This is a persisted server-stamp fixture, not a claim that a provider
    // failure or an OS crash occurred. Claimed/started timestamps alone are
    // insufficient. Exact versioned evidence and absent dispatch markers must
    // agree. Boot/delivery IDs are real claim/status bookkeeping, not provider
    // work; their presence must not prevent this proven pre-provider recovery.
    await server.db.update(heartbeatRuns).set({ status: "cancelled", runtimeMode: "legacy", startedAt: terminalAt,
      finishedAt: terminalAt, errorCode: "ai_connection_pool_exhausted",
      controllerBootId: randomUUID(), executionStatusDeliveryId: randomUUID(),
      resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false,
        qaPreProvider: { schema: "paperclip.qa-pre-provider/v1", runId: source.id, decisionId: qa.decisionId },
      } },
    }).where(eq(heartbeatRuns.id, source.id));
    await server.db.update(agentWakeupRequests).set({ status: "cancelled", claimedAt: terminalAt,
      finishedAt: terminalAt, updatedAt: terminalAt,
    }).where(eq(agentWakeupRequests.id, qa.wake.id));
    const [sourceBefore] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
    const scheduled = await qa.heartbeat.scheduleBoundedRetry(source.id, {
      now: terminalAt, retryReason: "ai_connection_pool_wait", wakeReason: "ai_connection_pool_retry",
      maxAttempts: 1, delayMs: 1_000,
    });
    expect(scheduled.outcome).toBe("scheduled");
    const [retry] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id));
    expect(retry).toMatchObject({ status: "scheduled_retry", contextSnapshot: {
      qaDecisionId: qa.decisionId, forceFreshSession: true,
    } });
    await server.db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } })
      .where(eq(agents.id, qa.implementerId));
    await qa.heartbeat.promoteDueScheduledRetries(new Date());
    const [suppressed] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry!.id));
    expect(suppressed).toMatchObject({ status: "cancelled", startedAt: null,
      errorCode: "heartbeat_wake_on_demand_disabled" });
    expect(qa.execute).not.toHaveBeenCalled();
    const blocking = await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, qa.fixture.companyId),
        eq(agentWakeupRequests.idempotencyKey, qa.wake.idempotencyKey!), qaDecisionWakeBlocksDelivery()));
    expect(blocking).toEqual([]);
    await server.db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } })
      .where(eq(agents.id, qa.implementerId));
    await qa.heartbeat.reconcileStrandedAssignedIssues();
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    expect(qa.execute).toHaveBeenCalledTimes(1);
    const actual = qa.execute.mock.calls[0]![0];
    expect(actual.runId).not.toBe(source.id);
    expect(actual.runId).not.toBe(retry!.id);
    expect(actual.context).toMatchObject({ qaDecisionId: qa.decisionId, forceFreshSession: true });
    expect(await qa.genericWakes()).toEqual([]);
    const [sourceAfter] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
    const { nextEventSeq: beforeSequence, updatedAt: beforeAuditAt, ...originalSource } = sourceBefore!;
    const { nextEventSeq: afterSequence, updatedAt: afterAuditAt, ...preservedSource } = sourceAfter!;
    // Scheduling appends exactly one lifecycle event to the source. Its
    // authority, terminal outcome, receipt linkage and provider evidence are
    // immutable; the event sequence and audit time are legitimate append-only
    // bookkeeping and must be checked separately rather than ignored.
    expect(preservedSource).toEqual(originalSource);
    expect(afterSequence).toBe(beforeSequence + 1);
    expect(afterAuditAt.getTime()).toBeGreaterThanOrEqual(beforeAuditAt.getTime());
    const appended = await server.db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, source.id), eq(heartbeatRunEvents.seq, beforeSequence),
    ));
    expect(appended).toEqual([expect.objectContaining({
      eventType: "lifecycle", stream: "system", level: "warn",
      message: `Scheduled bounded retry 1/1 for ${retry!.scheduledRetryAt!.toISOString()}`,
      payload: expect.objectContaining({ retryRunId: retry!.id,
        retryReason: "ai_connection_pool_wait", scheduledRetryAttempt: 1 }),
    })]);
    await qa.heartbeat.reconcileStrandedAssignedIssues();
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    expect(qa.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps claimed QA receipts fenced without exact versioned pre-provider evidence", async () => {
    const qa = await returnedQaFixture();
    const source = await qa.promote();
    const terminalAt = new Date(Date.now() - 31_000);
    await server.db.update(agentWakeupRequests).set({ status: "cancelled", claimedAt: terminalAt,
      finishedAt: terminalAt, updatedAt: terminalAt,
    }).where(eq(agentWakeupRequests.id, qa.wake.id));
    const proof = { schema: "paperclip.qa-pre-provider/v1", runId: source.id, decisionId: qa.decisionId };
    const variants = [
      { name: "old unversioned false", recovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
      { name: "another run", recovery: { kind: "ai_connection_wait", providerWorkStarted: false,
        qaPreProvider: { ...proof, runId: randomUUID() } } },
      { name: "another decision", recovery: { kind: "ai_connection_wait", providerWorkStarted: false,
        qaPreProvider: { ...proof, decisionId: randomUUID() } } },
      { name: "unknown proof schema", recovery: { kind: "ai_connection_wait", providerWorkStarted: false,
        qaPreProvider: { ...proof, schema: "paperclip.qa-pre-provider/unrecognized" } } },
      { name: "provider work began", recovery: { kind: "bootstrap", providerWorkStarted: true, qaPreProvider: proof } },
      { name: "provider work began despite an unclaimed outer shape",
        recovery: { kind: "bootstrap", providerWorkStarted: true }, preclaimShape: true },
      { name: "native execution", recovery: { kind: "bootstrap", providerWorkStarted: false, qaPreProvider: proof },
        runtimeMode: "native" as const },
      { name: "process dispatch marker", recovery: { kind: "bootstrap", providerWorkStarted: false, qaPreProvider: proof },
        processPid: 12345678 },
    ];
    for (const variant of variants) {
      await server.db.update(agentWakeupRequests).set({ claimedAt: variant.preclaimShape ? null : terminalAt })
        .where(eq(agentWakeupRequests.id, qa.wake.id));
      await server.db.update(heartbeatRuns).set({ status: "cancelled", runtimeMode: variant.runtimeMode ?? "legacy",
        startedAt: variant.preclaimShape ? null : terminalAt, finishedAt: terminalAt,
        errorCode: "ai_connection_pool_exhausted", controllerBootId: variant.preclaimShape ? null : randomUUID(),
        executionStatusDeliveryId: variant.preclaimShape ? null : randomUUID(),
        processPid: variant.processPid ?? null, resultJson: { executionRecovery: variant.recovery },
      }).where(eq(heartbeatRuns.id, source.id));
      const blocking = await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.id, qa.wake.id), qaDecisionWakeBlocksDelivery()));
      expect(blocking, variant.name).toEqual([{ id: qa.wake.id }]);
    }
    expect(qa.execute).not.toHaveBeenCalled();
    expect(await qa.genericWakes()).toEqual([]);
  });

  it("keeps a real QA setup failure out of generic continuation and redelivers after repair", async () => {
    const qa = await returnedQaFixture();
    const source = await qa.promote();
    // A deliberately invalid persisted binding fails in executeRun's setup
    // before adapter.execute. This is not a real credential or provider call.
    await server.db.update(agents).set({ runtimeConfig: {
      heartbeat: { enabled: false, wakeOnDemand: true }, aiConnection: { mode: "synthetic-invalid-binding" },
    } }).where(eq(agents.id, qa.implementerId));
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    const [failed] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
    expect(failed).toMatchObject({ status: "failed", errorCode: "setup_failed",
      runtimeMode: "legacy", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false,
        qaPreProvider: { schema: "paperclip.qa-pre-provider/v1", runId: source.id, decisionId: qa.decisionId },
      } } });
    expect(failed!.startedAt).not.toBeNull();
    expect(failed!.controllerBootId).toBeTruthy();
    expect(failed!.executionStatusDeliveryId).toBeTruthy();
    expect(qa.execute).not.toHaveBeenCalled();
    expect(await qa.genericWakes()).toEqual([]);
    const [failedWake] = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, qa.wake.id));
    expect(failedWake).toMatchObject({ status: "failed", runId: source.id });
    expect(failedWake!.claimedAt).not.toBeNull();
    // Only the synthetic invalid binding is repaired. Neither the old failed
    // run nor its result is rewritten into success or reused for execution.
    await server.db.update(agents).set({ status: "active",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    }).where(eq(agents.id, qa.implementerId));
    await qa.heartbeat.reconcileStrandedAssignedIssues();
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    expect(qa.execute).toHaveBeenCalledTimes(1);
    expect(qa.execute.mock.calls[0]![0].runId).not.toBe(source.id);
    expect(qa.execute.mock.calls[0]![0].context).toMatchObject({
      qaDecisionId: qa.decisionId, forceFreshSession: true,
    });
    expect(await qa.genericWakes()).toEqual([]);
    expect((await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id)))[0])
      .toEqual(failed);
    await qa.heartbeat.reconcileStrandedAssignedIssues();
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    expect(qa.execute).toHaveBeenCalledTimes(1);
  });

  it("preserves positive QA provider evidence when an inner terminal write fails into the outer catch", async () => {
    const qa = await returnedQaFixture();
    const source = await qa.promote();
    const [decisionBefore] = await server.db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.id, qa.decisionId));
    const suffix = randomUUID().replaceAll("-", "");
    const sequence = `qa_terminal_attempt_${suffix}`;
    const functionName = `qa_terminal_fault_${suffix}`;
    const trigger = `qa_terminal_trigger_${suffix}`;
    onTestFinished(async () => {
      try { await qa.heartbeat.drainActiveRunExecutions(); }
      finally {
        // These objects belong only to the disposable database and exact run.
        // Attempt all cleanup steps even if a test assertion or prior DROP
        // failed, then fail the fixture if any object could not be reclaimed.
        const failures: unknown[] = [];
        for (const ddl of [
          `DROP TRIGGER IF EXISTS ${trigger} ON heartbeat_runs`,
          `DROP FUNCTION IF EXISTS ${functionName}()`,
          `DROP SEQUENCE IF EXISTS ${sequence}`,
        ]) {
          try { await server.db.execute(sql.raw(ddl)); } catch (error) { failures.push(error); }
        }
        expect(failures).toEqual([]);
        const reclaimed = await server.db.execute(sql.raw(`SELECT
          to_regclass('${sequence}') IS NULL AS sequence_reclaimed,
          to_regprocedure('${functionName}()') IS NULL AS function_reclaimed,
          NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${trigger}') AS trigger_reclaimed`));
        expect(reclaimed[0]).toMatchObject({ sequence_reclaimed: true, function_reclaimed: true, trigger_reclaimed: true });
      }
    });
    await server.db.execute(sql.raw(`CREATE SEQUENCE ${sequence}`));
    await server.db.execute(sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${source.id}'::uuid AND OLD.status = 'running' AND NEW.status = 'failed' THEN
          IF nextval('${sequence}') = 1 THEN
            RAISE EXCEPTION 'Synthetic first QA terminal status write failure';
          END IF;
        END IF;
        RETURN NEW;
      END $$`));
    await server.db.execute(sql.raw(`CREATE TRIGGER ${trigger} BEFORE UPDATE OF status ON heartbeat_runs
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`));
    let providerEvidenceObserved = false;
    qa.execute.mockImplementationOnce(async ctx => {
      expect(ctx.runId).toBe(source.id);
      // Lock after the production handoff transaction. This observes its
      // committed fact without polling or racing a pre-commit snapshot.
      await server.db.transaction(async tx => {
        const [entered] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id)).for("update");
        expect(entered?.resultJson).toMatchObject({ executionRecovery: { providerWorkStarted: true } });
        const recovery = entered!.resultJson!.executionRecovery as Record<string, unknown>;
        expect(recovery.qaPreProvider).toBeUndefined();
      });
      providerEvidenceObserved = true;
      throw new Error("Synthetic QA adapter failure after provider entry");
    });
    await qa.heartbeat.resumeQueuedRuns();
    await qa.heartbeat.drainActiveRunExecutions();
    const attempts = await server.db.execute(sql.raw(`SELECT last_value, is_called FROM ${sequence}`));
    expect(attempts[0]?.is_called).toBe(true);
    expect(Number(attempts[0]?.last_value)).toBe(2);
    expect(providerEvidenceObserved).toBe(true);
    expect(qa.execute).toHaveBeenCalledTimes(1);
    const [failed] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
    expect(failed).toMatchObject({ status: "failed", errorCode: "setup_failed",
      resultJson: { executionRecovery: { providerWorkStarted: true } } });
    const recovery = failed!.resultJson!.executionRecovery as Record<string, unknown>;
    expect(recovery.qaPreProvider).toBeUndefined();
    expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.id, qa.wake.id), qaDecisionWakeBlocksDelivery())))
      .toEqual([{ id: qa.wake.id }]);
    expect(await qa.genericWakes()).toEqual([]);
    expect((await server.db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.id, qa.decisionId)))[0]).toEqual(decisionBefore);
  });

  it("joins a started QA provider before cleanup when the outer handoff transaction rolls back", async () => {
    const qa = await returnedQaFixture();
    const source = await qa.promote();
    let markEntered!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    let releaseProvider!: () => void;
    const providerLatch = new Promise<void>(resolve => { releaseProvider = resolve; });
    let markRollback!: () => void;
    const rolledBack = new Promise<void>(resolve => { markRollback = resolve; });
    let injected = 0;
    const faultDb = new Proxy(server.db, {
      get(target, property) {
        if (property === "transaction") {
          return async (...[callback, config]: Parameters<typeof server.db.transaction>) => {
            let rolledBackThisGate = false;
            try {
              return await target.transaction(async tx => {
                const result = await callback(tx);
                const gate = result as { dispatched?: unknown; resultPromise?: unknown } | null;
                if (!injected && gate?.dispatched === true && gate.resultPromise instanceof Promise) {
                  injected += 1;
                  rolledBackThisGate = true;
                  // The real callback has entered the synthetic provider.
                  // Throwing before transaction completion rolls back the
                  // actual PostgreSQL writes; no API outcome is fabricated.
                  throw new Error("Synthetic outer QA handoff commit failure");
                }
                return result;
              }, config);
            } catch (error) {
              if (rolledBackThisGate) markRollback();
              throw error;
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const heartbeat = heartbeatService(faultDb);
    qa.execute.mockImplementationOnce(async ctx => {
      expect(ctx.runId).toBe(source.id);
      // Do not lock/read the dispatch row here: the injected rollback occurs
      // only after this callback returns its still-pending provider promise.
      markEntered();
      await providerLatch;
      return { exitCode: 0, signal: null, timedOut: false, summary: "Synthetic provider joined after rollback" };
    });
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const awaitSignal = (signal: Promise<void>, label: string) => Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing synthetic ${label}`)), 10_000);
        timers.add(timer);
      }),
    ]);
    let drain: Promise<void> | undefined;
    try {
      await heartbeat.resumeQueuedRuns();
      await awaitSignal(entered, "provider entry");
      await awaitSignal(rolledBack, "handoff rollback");
      expect(injected).toBe(1);
      drain = heartbeat.drainActiveRunExecutions();
      const beforeProviderSettlement = await Promise.race([
        drain.then(() => "cleanup-settled-before-provider"),
        new Promise<string>(resolve => {
          const timer = setTimeout(() => resolve("provider-still-owned"), 250);
          timers.add(timer);
        }),
      ]);
      expect(beforeProviderSettlement).toBe("provider-still-owned");
      const [stillRunning] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
      const [stillOwned] = await server.db.select().from(issues).where(eq(issues.id, qa.fixture.issueId));
      expect(stillRunning!.status).toBe("running");
      expect(stillOwned!.executionRunId).toBe(source.id);
      expect(qa.execute).toHaveBeenCalledTimes(1);
      releaseProvider();
      await drain;
      const [failed] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
      expect(failed).toMatchObject({ status: "failed",
        resultJson: { executionRecovery: { providerWorkStarted: true } } });
      const recovery = failed!.resultJson!.executionRecovery as Record<string, unknown>;
      expect(recovery.qaPreProvider).toBeUndefined();
      expect(await qa.genericWakes()).toEqual([]);
      expect(qa.execute).toHaveBeenCalledTimes(1);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      releaseProvider();
      await (drain ?? heartbeat.drainActiveRunExecutions());
    }
  }, 30_000);

  it.each(["agent pause", "graceful shutdown"] as const)(
    "redelivers the same QA decision after an actual pre-provider %s",
    async (stopKind) => {
      const qa = await returnedQaFixture();
      const source = await qa.promote();
      const [decisionBefore] = await server.db.select().from(issueExecutionDecisions)
        .where(eq(issueExecutionDecisions.id, qa.decisionId));
      let signalPreparation!: () => void;
      const preparing = new Promise<void>(resolve => { signalPreparation = resolve; });
      let releasePreparation!: () => void;
      const preparationLatch = new Promise<void>(resolve => { releasePreparation = resolve; });
      let observedPreparation = false;
      const heartbeat = heartbeatService(server.db, {
        beforeResolvedInteractionContinuationDispatchCheck: async ({ runId, issueId }) => {
          if (runId !== source.id || observedPreparation) return;
          expect(issueId).toBe(qa.fixture.issueId);
          const [claimed] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
          expect(claimed).toMatchObject({ status: "running", runtimeMode: "legacy" });
          expect(claimed!.startedAt).not.toBeNull();
          // This hook precedes adapter readiness. A registered owner would
          // require Stop to join it, so terminal-before-latch would be the
          // wrong expectation and could deadlock this preparation fixture.
          expect(adapterExecutionControls.has(source.id)).toBe(false);
          observedPreparation = true;
          signalPreparation();
          await preparationLatch;
        },
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await heartbeat.resumeQueuedRuns();
        await Promise.race([
          preparing,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("QA preparation hook was not reached")), 10_000);
          }),
        ]);
        expect(qa.execute).not.toHaveBeenCalled();
        if (stopKind === "agent pause") {
          // These are the same two service operations used by the pause
          // route. Only the disposable fixture's implementer is affected.
          expect(await agentService(server.db).pause(qa.implementerId)).toMatchObject({ status: "paused" });
          expect(await heartbeat.cancelActiveForAgent(qa.implementerId)).toBe(1);
        } else {
          // Invoke the actual graceful-shutdown writer for this run only.
          // No OS signal, daemon shutdown, or production service is used.
          const stopped = await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [source.id]);
          expect(stopped.interruptedRunIds).toEqual([source.id]);
          expect(stopped.retryRunIds).toEqual([]);
        }
        const [beforeFinally] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
        const expectedStatus = stopKind === "agent pause" ? "cancelled" : "interrupted";
        const expectedCode = stopKind === "agent pause" ? "agent_paused" : "server_shutdown_interrupted";
        expect(beforeFinally).toMatchObject({ status: expectedStatus, errorCode: expectedCode,
          resultJson: { executionRecovery: { providerWorkStarted: false } },
        });
        const beforeRecovery = beforeFinally!.resultJson!.executionRecovery as Record<string, unknown>;
        expect(beforeRecovery.qaPreProvider).toBeUndefined();
        // A live owner can attest that work has not begun, but delivery must
        // remain fenced until that owner finishes all preparation and cleanup.
        expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.id, qa.wake.id), qaDecisionWakeBlocksDelivery())))
          .toEqual([{ id: qa.wake.id }]);
        expect(await server.db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, qa.fixture.companyId),
          eq(issueRecoveryActions.sourceIssueId, qa.fixture.issueId),
          eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
          eq(issueRecoveryActions.fingerprint, `legacy-execution:${source.id}`),
        ))).toEqual([]);
        expect(qa.execute).not.toHaveBeenCalled();
        // Let the real executor unwind its own preparation and cleanup. The
        // test never rewrites an old failure into a pre-provider false row.
        releasePreparation();
        await heartbeat.drainActiveRunExecutions();
        const [settled] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
        expect(settled).toMatchObject({ status: expectedStatus, errorCode: expectedCode,
          finishedAt: beforeFinally!.finishedAt,
          resultJson: { executionRecovery: { providerWorkStarted: false,
            qaPreProvider: { schema: "paperclip.qa-pre-provider/v1", runId: source.id, decisionId: qa.decisionId },
          } },
        });
        expect(qa.execute).not.toHaveBeenCalled();
        const [receipt] = await server.db.select().from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, qa.wake.id));
        expect(receipt).toMatchObject({ status: "cancelled", runId: source.id });
        expect(receipt!.claimedAt).not.toBeNull();
        expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.id, qa.wake.id), qaDecisionWakeBlocksDelivery()))).toEqual([]);
        expect(await qa.genericWakes()).toEqual([]);
        // The live executor's pre-provider observation must prevent creation
        // of a false-positive incident, not resolve/delete one afterwards.
        // Old UNKNOWN actions are outside this new source-run attestation.
        expect(await server.db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, qa.fixture.companyId),
          eq(issueRecoveryActions.sourceIssueId, qa.fixture.issueId),
          eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
          eq(issueRecoveryActions.fingerprint, `legacy-execution:${source.id}`),
        ))).toEqual([]);
        const [returned] = await server.db.select().from(issues).where(eq(issues.id, qa.fixture.issueId));
        expect(returned).toMatchObject({ status: "in_progress", assigneeAgentId: qa.implementerId,
          executionState: { status: "changes_requested", lastDecisionId: qa.decisionId },
        });
        // Resume the real agent gate, then use a new scheduler instance over
        // the persisted rows. This models recovery, not an OS crash/reboot.
        expect(await agentService(server.db).resume(qa.implementerId)).toMatchObject({ status: "idle" });
        const restartedScheduler = heartbeatService(server.db);
        await restartedScheduler.reconcileStrandedAssignedIssues();
        await restartedScheduler.resumeQueuedRuns();
        await restartedScheduler.drainActiveRunExecutions();
        expect(qa.execute).toHaveBeenCalledTimes(1);
        const next = qa.execute.mock.calls[0]![0];
        expect(next.runId).not.toBe(source.id);
        expect(next.context).toMatchObject({ qaDecisionId: qa.decisionId, forceFreshSession: true });
        expect(await qa.genericWakes()).toEqual([]);
        const [oldAfter] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
        expect(oldAfter).toMatchObject({ status: settled!.status, errorCode: settled!.errorCode,
          error: settled!.error, startedAt: settled!.startedAt, finishedAt: settled!.finishedAt,
          resultJson: settled!.resultJson, wakeupRequestId: settled!.wakeupRequestId,
        });
        expect((await server.db.select().from(issueExecutionDecisions)
          .where(eq(issueExecutionDecisions.id, qa.decisionId)))[0]).toEqual(decisionBefore);
        await restartedScheduler.reconcileStrandedAssignedIssues();
        await restartedScheduler.resumeQueuedRuns();
        await restartedScheduler.drainActiveRunExecutions();
        expect(qa.execute).toHaveBeenCalledTimes(1);
      } finally {
        if (timeout) clearTimeout(timeout);
        releasePreparation();
        await heartbeat.drainActiveRunExecutions();
      }
    }, 30_000,
  );

  it.each([false, true])("consumes the committed QA claim before provider dispatch (reaper wins: %s)", async reaperWins => {
    const qa = await returnedQaFixture();
    const source = await qa.promote();
    const [decisionBefore] = await server.db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.id, qa.decisionId));
    let observedClaim = 0;
    let recoveredAtEntry = false;
    let reapedSource: typeof heartbeatRuns.$inferSelect | undefined;
    const entryBarrierDb = new Proxy(server.db, {
      get(target, property) {
        if (property === "transaction") return async (...args: Parameters<typeof server.db.transaction>) => {
          const result = await target.transaction(...args);
          const claimed = result as typeof heartbeatRuns.$inferSelect | null;
          // Inspect the first actual claim COMMIT, not later preparation
          // transactions that also return a running Run snapshot.
          if (observedClaim === 0 && claimed?.id === source.id && claimed.status === "running") {
            observedClaim += 1;
            const [actual] = await target.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
            expect(claimed.runnerProfileJson).toEqual(actual!.runnerProfileJson);
            expect(claimed.runnerProfileJson).toMatchObject({ qaClaimPreparation: {
              schema: "paperclip.qa-claim-preparation/v1", state: "pending", runId: source.id,
              decisionId: qa.decisionId, controllerBootId: claimed.controllerBootId } });
          }
          return result;
        };
        if (property === "update") return ((table: unknown) => {
          const update = target.update(table as typeof heartbeatRuns);
          return new Proxy(update, { get(updateTarget, updateProperty) {
            if (updateProperty !== "set") return Reflect.get(updateTarget, updateProperty, updateTarget);
            return (values: Record<string, unknown>) => {
              const setter = updateTarget.set(values);
              if (table !== heartbeatRuns || !reaperWins || recoveredAtEntry || !values.runnerProfileJson ||
                  !values.updatedAt || Object.keys(values).length !== 2) return setter;
              return new Proxy(setter, { get(setTarget, setProperty) {
                if (setProperty !== "where") return Reflect.get(setTarget, setProperty, setTarget);
                return (...whereArgs: Parameters<typeof setter.where>) => {
                  const query = setTarget.where(...whereArgs);
                  return new Proxy(query, { get(queryTarget, queryProperty) {
                    if (queryProperty !== "returning") return Reflect.get(queryTarget, queryProperty, queryTarget);
                    return async () => {
                      const [beforeEntry] = await target.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
                      expect(beforeEntry!.runnerProfileJson).toMatchObject({ qaClaimPreparation: { state: "pending" } });
                      recoveredAtEntry = true;
                      await target.update(heartbeatRuns).set({
                        controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
                      }).where(eq(heartbeatRuns.id, source.id));
                      expect((await heartbeatService(target).reapOrphanedRuns()).runIds).toContain(source.id);
                      [reapedSource] = await target.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
                      return queryTarget.returning();
                    };
                  } });
                };
              } });
            };
          } });
        }) as typeof target.update;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const enteredAtDispatch: string[] = [];
    const implementation = qa.execute.getMockImplementation()!;
    qa.execute.mockImplementation(async ctx => {
      const [actual] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ctx.runId));
      expect(actual!.runnerProfileJson).toMatchObject({ qaClaimPreparation: {
        schema: "paperclip.qa-claim-preparation/v1", state: "entered", runId: ctx.runId,
        decisionId: qa.decisionId, controllerBootId: actual!.controllerBootId } });
      enteredAtDispatch.push(ctx.runId);
      return implementation(ctx);
    });
    const heartbeat = heartbeatService(entryBarrierDb);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(observedClaim).toBe(1);
    if (reaperWins) {
      expect(recoveredAtEntry).toBe(true);
      expect(qa.execute).not.toHaveBeenCalled();
      const restarted = heartbeatService(server.db);
      await restarted.reconcileStrandedAssignedIssues();
      await restarted.resumeQueuedRuns();
      await restarted.drainActiveRunExecutions();
      expect(enteredAtDispatch).toHaveLength(1);
      expect(enteredAtDispatch[0]).not.toBe(source.id);
      expect((await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id)))[0])
        .toMatchObject({ status: reapedSource!.status, errorCode: reapedSource!.errorCode,
          finishedAt: reapedSource!.finishedAt, resultJson: reapedSource!.resultJson });
      await restarted.reconcileStrandedAssignedIssues();
      await restarted.resumeQueuedRuns();
      await restarted.drainActiveRunExecutions();
    } else expect(enteredAtDispatch).toEqual([source.id]);
    expect(qa.execute).toHaveBeenCalledTimes(1);
    expect(await qa.genericWakes()).toEqual([]);
    expect((await server.db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.id, qa.decisionId)))[0]).toEqual(decisionBefore);
  }, 30_000);

  it.each(["unconsumed", "entered", "old_unversioned", "provider_started"] as const)(
    "handles an expired QA claim without replaying entered or unknown work: %s", async state => {
    const qa = await returnedQaFixture();
    const source = await qa.promote();
    const [decisionBefore] = await server.db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.id, qa.decisionId));
    let lostClaim = false;
    const lostControllerDb = new Proxy(server.db, {
      get(target, property) {
        if (property === "transaction") return async (...args: Parameters<typeof server.db.transaction>) => {
          const result = await target.transaction(...args);
          const claimed = result as { id?: unknown; status?: unknown } | null;
          if (!lostClaim && claimed?.id === source.id && claimed.status === "running") {
            lostClaim = true;
            // Lose the caller after the actual claim COMMIT, before executeRun
            // receives it. This reproduces the persisted crash state, not an
            // OS SIGKILL; it does not fabricate an old failure/no-provider row.
            throw new Error("Synthetic controller loss after QA claim commit");
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const lostController = heartbeatService(lostControllerDb);
    await expect(lostController.resumeQueuedRuns()).rejects.toThrow("Synthetic controller loss after QA claim commit");
    await lostController.drainActiveRunExecutions();
    expect(lostClaim).toBe(true);
    const [claimed] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
    expect(claimed).toMatchObject({ status: "running", executionStage: "preparing" });
    expect((await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, qa.wake.id)))[0]).toMatchObject({ status: "claimed", runId: source.id });
    expect((await qa.issueDetail(source.id)).executionRunId).toBe(source.id);
    expect(qa.execute).not.toHaveBeenCalled();
    expect(await server.db.select().from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, source.id))).toEqual([]);
    // Negative controls represent a preparation that entered, an older claim
    // without this contract, and an explicitly dispatched provider. They must
    // never acquire a no-provider proof from expiry alone.
    if (state === "entered") await server.db.update(heartbeatRuns).set({
      runnerProfileJson: sql`jsonb_set(${heartbeatRuns.runnerProfileJson}, '{qaClaimPreparation,state}', '"entered"'::jsonb)`,
    }).where(eq(heartbeatRuns.id, source.id));
    if (state === "old_unversioned") await server.db.update(heartbeatRuns).set({
      runnerProfileJson: sql`${heartbeatRuns.runnerProfileJson} - 'qaClaimPreparation'`,
    }).where(eq(heartbeatRuns.id, source.id));
    if (state === "provider_started") await server.db.update(heartbeatRuns).set({
      resultJson: { executionRecovery: { kind: "provider_failure", providerWorkStarted: true } },
    }).where(eq(heartbeatRuns.id, source.id));
    // Advance only the disposable controller lease clock. Preserve source
    // context, claim/wake IDs, decision, outcome and all UNKNOWN history.
    await server.db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(heartbeatRuns.id, source.id));
    const restarted = heartbeatService(server.db);
    const reaped = await restarted.reapOrphanedRuns();
    const [settled] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
    if (state !== "unconsumed") {
      expect((settled!.resultJson?.executionRecovery as Record<string, unknown> | undefined)?.qaPreProvider)
        .toBeUndefined();
      if (state === "provider_started") expect(settled!.resultJson!.executionRecovery)
        .toMatchObject({ providerWorkStarted: true });
      expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.id, qa.wake.id), qaDecisionWakeBlocksDelivery())))
        .toEqual([{ id: qa.wake.id }]);
      await restarted.reconcileStrandedAssignedIssues();
      await restarted.resumeQueuedRuns();
      await restarted.drainActiveRunExecutions();
      expect(qa.execute).not.toHaveBeenCalled();
      expect(await qa.genericWakes()).toEqual([]);
      expect((await server.db.select().from(issueExecutionDecisions)
        .where(eq(issueExecutionDecisions.id, qa.decisionId)))[0]).toEqual(decisionBefore);
      return;
    }
    expect(reaped.runIds).toContain(source.id);
    expect(settled).toMatchObject({ status: "failed", errorCode: "process_lost",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false,
        qaPreProvider: { schema: "paperclip.qa-pre-provider/v1", runId: source.id, decisionId: qa.decisionId },
        orphanClaim: { schema: "paperclip.qa-orphan-claim/v1", controllerBootId: claimed!.controllerBootId },
      } } });
    expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.id, qa.wake.id), qaDecisionWakeBlocksDelivery()))).toEqual([]);
    expect(await server.db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, qa.fixture.companyId),
      eq(issueRecoveryActions.fingerprint, `legacy-execution:${source.id}`)))).toEqual([]);
    expect(await qa.genericWakes()).toEqual([]);
    await restarted.reconcileStrandedAssignedIssues();
    await restarted.resumeQueuedRuns();
    await restarted.drainActiveRunExecutions();
    expect(qa.execute).toHaveBeenCalledTimes(1);
    expect(qa.execute.mock.calls[0]![0]).toMatchObject({
      context: { qaDecisionId: qa.decisionId, forceFreshSession: true },
    });
    expect(qa.execute.mock.calls[0]![0].runId).not.toBe(source.id);
    expect((await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id)))[0]).toEqual(settled);
    expect((await server.db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.id, qa.decisionId)))[0]).toEqual(decisionBefore);
    expect(await qa.genericWakes()).toEqual([]);
    await restarted.reconcileStrandedAssignedIssues();
    await restarted.resumeQueuedRuns();
    await restarted.drainActiveRunExecutions();
    expect(qa.execute).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("settles a QA cancellation after claim commit but before execute preparation begins", async () => {
    const qa = await returnedQaFixture();
    const source = await qa.promote();
    const [decisionBefore] = await server.db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.id, qa.decisionId));
    let signalCommitted!: () => void;
    const committed = new Promise<void>(resolve => { signalCommitted = resolve; });
    let releaseClaim!: () => void;
    const claimLatch = new Promise<void>(resolve => { releaseClaim = resolve; });
    let heldClaim = 0;
    const claimBarrierDb = new Proxy(server.db, {
      get(target, property) {
        if (property === "transaction") {
          return async (...args: Parameters<typeof server.db.transaction>) => {
            // Await the actual outer PostgreSQL commit. Do not intercept an
            // inner savepoint or replace any query/transaction return value.
            const result = await target.transaction(...args);
            const claimed = result as { id?: unknown; status?: unknown } | null;
            if (!heldClaim && claimed?.id === source.id && claimed.status === "running") {
              heldClaim += 1;
              signalCommitted();
              await claimLatch;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const heartbeat = heartbeatService(claimBarrierDb);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const deadline = <T>(promise: Promise<T>, message: string) => Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timers.push(setTimeout(() => reject(new Error(message)), 10_000));
      }),
    ]);
    const resuming = heartbeat.resumeQueuedRuns();
    let stopping: Promise<number> | undefined;
    try {
      await deadline(committed, "The actual QA claim commit barrier was not reached");
      const [claimed] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
      expect(claimed).toMatchObject({ status: "running" });
      expect(claimed!.controllerBootId).not.toBeNull();
      expect((await server.db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, qa.wake.id)))[0]).toMatchObject({ status: "claimed", runId: source.id });
      expect((await server.db.select().from(issues).where(eq(issues.id, qa.fixture.issueId)))[0])
        .toMatchObject({ executionRunId: source.id });
      expect(adapterExecutionControls.has(source.id)).toBe(false);
      expect(qa.execute).not.toHaveBeenCalled();
      await agentService(server.db).pause(qa.implementerId);
      stopping = heartbeatService(server.db).cancelActiveForAgent(qa.implementerId);
      expect(await deadline(stopping, "QA claim-gap cancellation did not settle")).toBe(1);
      const [cancelledBeforeExecute] = await server.db.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, source.id));
      expect(cancelledBeforeExecute).toMatchObject({ status: "cancelled", errorCode: "agent_paused",
        resultJson: { executionRecovery: { providerWorkStarted: false } },
      });
      expect((cancelledBeforeExecute!.resultJson!.executionRecovery as Record<string, unknown>).qaPreProvider)
        .toBeUndefined();
      expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.id, qa.wake.id), qaDecisionWakeBlocksDelivery())))
        .toEqual([{ id: qa.wake.id }]);
      releaseClaim();
      await resuming;
      await heartbeat.drainActiveRunExecutions();
      const [settled] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
      expect(settled).toMatchObject({ status: "cancelled", errorCode: "agent_paused",
        finishedAt: cancelledBeforeExecute!.finishedAt,
        resultJson: { executionRecovery: { providerWorkStarted: false,
          qaPreProvider: { schema: "paperclip.qa-pre-provider/v1", runId: source.id, decisionId: qa.decisionId },
        } },
      });
      expect(qa.execute).not.toHaveBeenCalled();
      expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.id, qa.wake.id), qaDecisionWakeBlocksDelivery()))).toEqual([]);
      expect(await server.db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, qa.fixture.companyId),
        eq(issueRecoveryActions.sourceIssueId, qa.fixture.issueId),
        eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
        eq(issueRecoveryActions.fingerprint, `legacy-execution:${source.id}`),
      ))).toEqual([]);
      expect(await qa.genericWakes()).toEqual([]);
      await agentService(server.db).resume(qa.implementerId);
      const restarted = heartbeatService(server.db);
      await restarted.reconcileStrandedAssignedIssues();
      await restarted.resumeQueuedRuns();
      await restarted.drainActiveRunExecutions();
      expect(qa.execute).toHaveBeenCalledTimes(1);
      expect(qa.execute.mock.calls[0]![0]).toMatchObject({
        context: { qaDecisionId: qa.decisionId, forceFreshSession: true },
      });
      expect(qa.execute.mock.calls[0]![0].runId).not.toBe(source.id);
      expect((await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id)))[0])
        .toMatchObject({ status: settled!.status, errorCode: settled!.errorCode,
          finishedAt: settled!.finishedAt, resultJson: settled!.resultJson });
      expect((await server.db.select().from(issueExecutionDecisions)
        .where(eq(issueExecutionDecisions.id, qa.decisionId)))[0]).toEqual(decisionBefore);
      expect(await qa.genericWakes()).toEqual([]);
      await restarted.reconcileStrandedAssignedIssues();
      await restarted.resumeQueuedRuns();
      await restarted.drainActiveRunExecutions();
      expect(qa.execute).toHaveBeenCalledTimes(1);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      releaseClaim();
      await resuming;
      await stopping;
      await heartbeat.drainActiveRunExecutions();
    }
  }, 30_000);

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
    await server.db.update(issues).set({ executionPolicy: policy ? { ...policy } : null, responsibleUserId: fixture.responsibleUserId,
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
      const policy = normalizeIssueExecutionPolicy(current?.executionPolicy);
      if (!current || !policy) throw new Error("QA return fixture lost its execution policy");
      const transition = applyIssueExecutionPolicyTransition({
        issue: current, policy, previousPolicy: policy,
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
      const policy = normalizeIssueExecutionPolicy(current?.executionPolicy);
      if (!current || !policy) throw new Error("Stopped QA return fixture lost its execution policy");
      const transition = applyIssueExecutionPolicyTransition({
        issue: current, policy, previousPolicy: policy,
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
    expect(heldReceipt).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { executionWait: { reason: "qa_predecessor_ownership_active" } } });
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
    expect(consumed!.payload?.executionWait).toBeUndefined();
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

  it.each([false, true])("admits a new QA document episode only when every recovery action is document-held (mixed: %s)", async mixed => {
    const { fixture, stageId, tool } = await reviewFixture();
    await server.db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.blockerId));
    await server.db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } })
      .where(eq(agents.id, fixture.agentId));
    const adapterType = `qa_document_blocker_stub_${randomUUID().replaceAll("-", "")}`;
    let implementerId: string | null = null;
    const execute = vi.fn<ServerAdapterModule["execute"]>(async ctx => {
      if (ctx.agent.id !== implementerId || ctx.context.issueId !== fixture.issueId) {
        throw new Error("Unexpected provider dispatch in document blocker fixture");
      }
      const [current] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
      const policy = normalizeIssueExecutionPolicy(current?.executionPolicy);
      if (!current || !policy) throw new Error("Document blocker fixture lost its execution policy");
      const transition = applyIssueExecutionPolicyTransition({
        issue: current, policy, previousPolicy: policy,
        requestedStatus: "in_review", requestedAssigneePatch: {},
        actor: { agentId: implementerId, userId: null },
        commentBody: "Synthetic document revision is ready for review.",
      });
      await server.db.update(issues).set({ ...transition.patch,
        revision: current.revision + 1, statusVersion: current.statusVersion + 1,
      }).where(eq(issues.id, fixture.issueId));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Synthetic document revision resubmitted" };
    });
    registerServerAdapter({ type: adapterType, execute,
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    onTestFinished(async () => {
      await heartbeatService(server.db).drainActiveRunExecutions();
      unregisterServerAdapter(adapterType);
    });
    const [implementer] = await server.db.insert(agents).values({ companyId: fixture.companyId,
      name: "Document return assignee", adapterType, status: "active",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    }).returning();
    implementerId = implementer!.id;
    const [before] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    await server.db.update(issues).set({ executionState: {
      ...(before!.executionState as Record<string, unknown>),
      returnAssignee: { type: "agent", agentId: implementerId },
    } }).where(eq(issues.id, fixture.issueId));
    const assigned = (await tool("read_assigned_issue")).body.result.structuredContent;
    const verdict = await tool("submit_review_decision", {
      decision: "request_changes", summary: "Please revise the document evidence.",
      expectedStageId: stageId, expectedStatusVersion: assigned.statusVersion,
      expectedRevision: assigned.revision, expectedLastDecisionId: assigned.reviewStage.lastDecisionId,
    });
    expect(verdict.body.result.isError).not.toBe(true);
    const decisionId = verdict.body.result.structuredContent.decisionId as string;
    await expect.poll(() => server.db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, fixture.companyId),
      eq(agentWakeupRequests.idempotencyKey, `qa-decision:${decisionId}`),
    )), { timeout: 10_000 }).toEqual([expect.objectContaining({ status: "deferred_issue_execution", runId: null })]);
    const [deferred] = await server.db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, fixture.companyId),
      eq(agentWakeupRequests.idempotencyKey, `qa-decision:${decisionId}`),
    ));
    const finishedAt = new Date();
    await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt })
      .where(eq(heartbeatRuns.id, fixture.runId));
    settleSyntheticReviewProcess(fixture.runId);

    // Both old runs have terminal receipts and no process, lease or finalization
    // ownership. Only the newer source has the server document stamp.
    const [oldOtherRun, oldDocumentRun] = await server.db.insert(heartbeatRuns).values([
      { companyId: fixture.companyId, agentId: implementerId, status: "failed",
        invocationSource: "assignment", triggerDetail: "system", nativeIssueId: fixture.issueId,
        contextSnapshot: { issueId: fixture.issueId }, startedAt: new Date(finishedAt.getTime() - 180_000),
        finishedAt: new Date(finishedAt.getTime() - 120_000) },
      { companyId: fixture.companyId, agentId: implementerId, status: "failed",
        invocationSource: "assignment", triggerDetail: "system", nativeIssueId: fixture.issueId,
        contextSnapshot: { issueId: fixture.issueId, [SELF_TASK_DOCUMENT_CONTEXT_KEY]: true },
        startedAt: new Date(finishedAt.getTime() - 120_000),
        finishedAt: new Date(finishedAt.getTime() - 60_000) },
    ]).returning();
    const olderAt = new Date(finishedAt.getTime() - 120_000);
    const newerAt = new Date(finishedAt.getTime() - 60_000);
    if (mixed) await server.db.insert(issueRecoveryActions).values({
      companyId: fixture.companyId, sourceIssueId: fixture.issueId,
      kind: "active_run_watchdog", status: "active", ownerType: "board",
      cause: "uncertain_external_action", fingerprint: `non-document:${oldOtherRun!.id}`,
      evidence: { runId: oldOtherRun!.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      nextAction: "Reconcile the earlier external effect before execution.", updatedAt: olderAt,
    });
    const [documentAction] = await server.db.insert(issueRecoveryActions).values({
      companyId: fixture.companyId, sourceIssueId: fixture.issueId,
      kind: "active_run_watchdog", status: "resolved", ownerType: "board",
      cause: "uncertain_external_action", fingerprint: `document:${oldDocumentRun!.id}`,
      evidence: { runId: oldDocumentRun!.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      nextAction: "Preserve the old document effect without replay.", updatedAt: newerAt, resolvedAt: newerAt,
    }).returning();
    const actions = () => server.db.select().from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, fixture.companyId),
        eq(issueRecoveryActions.sourceIssueId, fixture.issueId)));
    const oldRuns = () => server.db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id,
      [oldOtherRun!.id, oldDocumentRun!.id]));
    const byId = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
    const actionsBefore = byId(await actions());
    const oldRunsBefore = byId(await oldRuns());
    expect(actionsBefore).toHaveLength(mixed ? 2 : 1);
    expect(oldRunsBefore).toHaveLength(2);
    expect(await getExecutionBlocker(server.db, fixture.companyId, fixture.issueId))
      .toMatchObject({ recoveryActionId: documentAction!.id, runId: oldDocumentRun!.id });

    await server.db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 31_000) })
      .where(eq(agentWakeupRequests.id, deferred!.id));
    const heartbeat = heartbeatService(server.db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const [wakeAfter] = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferred!.id));
    const newQaRuns = await server.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, fixture.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'qaDecisionId' = ${decisionId}`,
    ));
    if (mixed) {
      expect(wakeAfter).toMatchObject({ status: "deferred_issue_execution", runId: null,
        idempotencyKey: `qa-decision:${decisionId}` });
      expect(newQaRuns).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    } else {
      const admissionReadback = JSON.stringify({
        wake: { status: wakeAfter?.status, reason: wakeAfter?.reason, error: wakeAfter?.error,
          payload: wakeAfter?.payload, runId: wakeAfter?.runId },
        newQaRuns: newQaRuns.map(run => ({ id: run.id, status: run.status,
          errorCode: run.errorCode, startedAt: run.startedAt, wakeupRequestId: run.wakeupRequestId })),
      });
      expect(wakeAfter?.status, admissionReadback).toBe("completed");
      expect(wakeAfter).toMatchObject({ status: "completed", idempotencyKey: `qa-decision:${decisionId}` });
      expect(newQaRuns).toHaveLength(1);
      expect(newQaRuns[0]).toMatchObject({ id: wakeAfter!.runId, agentId: implementerId,
        status: "succeeded", sessionIdBefore: null,
        contextSnapshot: { qaDecisionId: decisionId, forceFreshSession: true } });
      expect(newQaRuns[0]!.startedAt).not.toBeNull();
      expect(execute.mock.calls.map(([ctx]) => ctx.runId)).toEqual([newQaRuns[0]!.id]);
    }
    expect(byId(await actions())).toEqual(actionsBefore);
    expect(byId(await oldRuns())).toEqual(oldRunsBefore);
  });

  it.each(["decision", "stage", "assignee", "budget"] as const)(
    "settles a queued QA return when its %s authority is superseded",
    async (invalidated) => {
      const budgetCheckpoint = (stage: string) => {
        if (invalidated === "budget") console.info(`qa-stale-budget checkpoint: ${stage}`);
      };
      budgetCheckpoint("fixture-start");
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
      budgetCheckpoint("route-decision-and-wake-committed");
      const [current] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
      const state = current!.executionState as Record<string, unknown>;
      if (invalidated === "budget") {
        await server.db.insert(budgetPolicies).values({ companyId: fixture.companyId,
          scopeType: "agent", scopeId: implementer!.id, metric: "billed_cents",
          windowKind: "calendar_month_utc", amount: 1, hardStopEnabled: true, isActive: true });
        await server.db.insert(costEvents).values({ companyId: fixture.companyId,
          agentId: implementer!.id, provider: "test", biller: "test", billingType: "tokens",
          model: "test-model", costCents: 1, occurredAt: new Date() });
        budgetCheckpoint("budget-db-seed-committed");
      } else await server.db.update(issues).set(invalidated === "assignee"
        ? { assigneeAgentId: fixture.agentId }
        : { executionState: { ...state,
          [invalidated === "decision" ? "lastDecisionId" : "currentStageId"]: randomUUID(),
        } }).where(eq(issues.id, fixture.issueId));
      const heartbeat = heartbeatService(server.db);
      budgetCheckpoint("first-resume-start");
      await heartbeat.resumeQueuedRuns();
      budgetCheckpoint("first-resume-finished");
      const [stale] = await server.db.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wake!.runId!));
      budgetCheckpoint("first-resume-db-read-finished");
      expect(stale).toMatchObject({ status: "cancelled", errorCode:
        invalidated === "budget" ? "cancelled" :
        invalidated === "assignee" ? "issue_assignee_changed" : "queued_run_claim_rejected" });
      expect(stale!.startedAt).toBeNull();
      // A new service instance models startup recovery against the persisted
      // row; a stale authority must not stay queued for every later scan.
      budgetCheckpoint("second-resume-start");
      await heartbeatService(server.db).resumeQueuedRuns();
      budgetCheckpoint("second-resume-finished");
      const [stillStale] = await server.db.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wake!.runId!));
      budgetCheckpoint("second-resume-db-read-finished");
      expect(stillStale!.status).toBe("cancelled");
      expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, wake!.idempotencyKey!))).toHaveLength(1);
      if (invalidated === "budget") {
        const [held] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
        expect(held).toMatchObject({ status: "in_progress", assigneeAgentId: implementer!.id,
          executionState: { status: "changes_requested" } });
        expect(await server.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.companyId, fixture.companyId),
            eq(agentWakeupRequests.reason, "issue_continuation_needed")))).toEqual([]);
      }
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

  it("does not let superseded QA authorities occupy the recovery page", async () => {
    const fixture = await server.fixture({ connectionScenario: "fresh", reset: true });
    await server.db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.blockerId));
    const [agent] = await server.db.insert(agents).values({ companyId: fixture.companyId,
      name: "Recovery page assignee", adapterType: "paperclip_runner", status: "active",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }).returning();
    const seeds = Array.from({ length: 102 }, (_, i) => ({ issueId: randomUUID(), stageId: randomUUID(),
      decisionId: randomUUID(), valid: i === 101, updatedAt: new Date(Date.now() - (200 - i) * 1000) }));
    await server.db.insert(issues).values(seeds.map(seed => ({ id: seed.issueId,
      companyId: fixture.companyId, projectId: fixture.projectId, title: "Synthetic recovery page",
      status: "in_progress", assigneeAgentId: agent!.id, responsibleUserId: fixture.responsibleUserId,
      updatedAt: seed.updatedAt, executionState: { status: "changes_requested",
        currentStageId: seed.stageId, lastDecisionId: seed.decisionId,
        returnAssignee: { type: "agent", agentId: seed.valid ? agent!.id : fixture.agentId } } })));
    await server.db.insert(issueExecutionDecisions).values(seeds.map(seed => ({ id: seed.decisionId,
      companyId: fixture.companyId, issueId: seed.issueId, stageId: seed.stageId, stageType: "review",
      outcome: "changes_requested", freshEpisodeWakeRequested: true, body: "Synthetic page authority" })));
    await server.db.insert(heartbeatRuns).values(seeds.map(seed => ({ companyId: fixture.companyId,
      agentId: agent!.id, status: "running", invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId: seed.issueId } })));
    await heartbeatService(server.db).reconcileStrandedAssignedIssues();
    const receipts = await server.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agent!.id));
    expect(receipts).toEqual([expect.objectContaining({ status: "skipped", payload: expect.objectContaining({
      issueId: seeds[101]!.issueId, executionWait: expect.objectContaining({
        requestedIdempotencyKey: `qa-decision:${seeds[101]!.decisionId}` }) }) })]);
  });

  it("keeps a daily-capped deferred QA receipt without accumulating skipped aliases", async () => {
    const fixture = await server.fixture({ connectionScenario: "fresh", reset: true });
    const [agent] = await server.db.insert(agents).values({ companyId: fixture.companyId,
      name: "Capped deferred assignee", adapterType: "paperclip_runner", status: "active",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxDailyRuns: 0 } } }).returning();
    const issueId = randomUUID(), stageId = randomUUID(), decisionId = randomUUID();
    await server.db.insert(issues).values({ id: issueId, companyId: fixture.companyId,
      projectId: fixture.projectId, title: "Synthetic deferred cap", status: "in_progress",
      assigneeAgentId: agent!.id, responsibleUserId: fixture.responsibleUserId,
      executionState: { status: "changes_requested", currentStageId: stageId, lastDecisionId: decisionId,
        currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: fixture.agentId },
        lastDecisionOutcome: "changes_requested", returnAssignee: { type: "agent", agentId: agent!.id } } });
    await server.db.insert(issueExecutionDecisions).values({ id: decisionId, companyId: fixture.companyId,
      issueId, stageId, stageType: "review", outcome: "changes_requested",
      freshEpisodeWakeRequested: true, body: "Synthetic deferred cap" });
    const [wake] = await server.db.insert(agentWakeupRequests).values({ companyId: fixture.companyId,
      agentId: agent!.id, source: "assignment", triggerDetail: "system", reason: "execution_changes_requested",
      payload: { issueId }, status: "deferred_issue_execution", idempotencyKey: `qa-decision:${decisionId}`,
      updatedAt: new Date(Date.now() - 31_000) }).returning();
    for (let i = 0; i < 2; i++) {
      await server.db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 31_000) })
        .where(eq(agentWakeupRequests.id, wake!.id));
      await heartbeatService(server.db).resumeQueuedRuns();
      expect(await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agent!.id)))
        .toEqual([expect.objectContaining({ id: wake!.id, status: "deferred_issue_execution", runId: null,
          payload: { issueId, executionWait: expect.objectContaining({ reason: "heartbeat.daily_run_limit" }) } })]);
    }
  });

});
