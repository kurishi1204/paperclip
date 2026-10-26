import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { agentSessionGoalActions, agentTaskSessions, agents, completionContracts, heartbeatRuns, issueExecutionDecisions, issueWorkProducts, issues, nativeRunFinalizations, nativeRunResults, statusDecisions } from "@paperclipai/db";
import { startRunnerToolBridge, type RunnerToolBridge } from "@paperclipai/paperclip-runner";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { normalizeIssueExecutionPolicy } from "../issue-execution-policy.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { runnerApiRestriction } from "./runner-api-policy.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { classifyNativeEvidence } from "./evidence-classifier.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";

type RpcResult = {
  result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean };
};
type RunnerApiServer = Awaited<ReturnType<typeof startRunnerApiTestServer>>;
type RunnerFixture = Awaited<ReturnType<RunnerApiServer["fixture"]>>;

describe("native issue approval stage", () => {
  let server: RunnerApiServer;
  let bridge: RunnerToolBridge;
  let fixture: RunnerFixture;
  let authority: PaperclipRunnerToolAuthority;
  let approvalStageId: string;
  let previousDecisionId: string;
  let workerId: string;

  async function rpc(id: string, method: string, params?: object): Promise<RpcResult> {
    const response = await fetch(bridge.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<RpcResult>;
  }

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    server = await startRunnerApiTestServer();
    vi.stubEnv("PAPERCLIP_API_URL", server.apiUrl);
  }, 90_000);

  beforeEach(async () => {
    fixture = await server.fixture({ disableWakeOnDemand: true });
    const reviewStageId = randomUUID();
    approvalStageId = randomUUID();
    previousDecisionId = randomUUID();
    workerId = randomUUID();
    const reviewerId = randomUUID();
    await server.db.insert(agents).values([
      { id: workerId, companyId: fixture.companyId, name: "Original worker", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } }, status: "active" },
      { id: reviewerId, companyId: fixture.companyId, name: "Previous reviewer", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } }, status: "active" },
    ]);
    const policy = normalizeIssueExecutionPolicy({ stages: [
      { id: reviewStageId, type: "review", participants: [{ type: "agent", agentId: reviewerId }] },
      { id: approvalStageId, type: "approval", participants: [{ type: "agent", agentId: fixture.agentId }] },
    ] });
    await server.db.insert(issueExecutionDecisions).values({
      id: previousDecisionId, companyId: fixture.companyId, issueId: fixture.issueId,
      stageId: reviewStageId, stageType: "review", actorAgentId: reviewerId,
      outcome: "approved", body: "The review stage passed.",
    });
    await server.db.update(issues).set({
      status: "in_review", executionPolicy: policy as unknown as Record<string, unknown>, executionRunId: fixture.runId,
      executionState: {
        status: "pending", currentStageId: approvalStageId, currentStageIndex: 1,
        currentStageType: "approval", currentParticipant: { type: "agent", agentId: fixture.agentId },
        returnAssignee: { type: "agent", agentId: workerId }, reviewRequest: null,
        completedStageIds: [reviewStageId], lastDecisionId: previousDecisionId,
        lastDecisionOutcome: "approved", monitor: null, changesRequestedCount: 0,
      },
    }).where(eq(issues.id, fixture.issueId));
    // Match native-session-executor's actual binding: it does not pass apiUrl.
    // Production obtains the server-owned origin from PAPERCLIP_API_URL.
    authority = new PaperclipRunnerToolAuthority(server.db, {
      companyId: fixture.companyId, issueId: fixture.issueId,
      agentId: fixture.agentId, runId: fixture.runId, workMode: "standard",
    });
    bridge = await startRunnerToolBridge({
      tools: authority.definitions(),
      handler: ({ tool, callId, arguments: args }) => authority.execute({ tool, callId, arguments: args }),
    });
  }, 30_000);

  afterEach(async () => { await bridge?.close(); });

  afterAll(async () => {
    await server?.close();
    vi.unstubAllEnvs();
  });

  it("control: the bound run reads its task through the real bridge", async () => {
    const listed = await rpc("control-list", "tools/list");
    expect(listed.result?.tools?.map(({ name }) => name)).toContain("get_task_context");
    const read = await rpc("control-read", "tools/call", { name: "get_task_context", arguments: {} });
    expect(read.result?.isError).not.toBe(true);
    expect(read.result?.content?.[0]?.text).toContain(fixture.issueId);
    expect(read.result?.content?.[0]?.text).toContain(fixture.runId);
  });

  it("records request_changes only through a run-bound approval tool and preserves the approver run", async () => {
    const listed = await rpc("approval-list", "tools/list");
    const names = listed.result?.tools?.map(({ name }) => name) ?? [];
    expect(names).toContain("decide_issue_approval_stage");
    expect(names).not.toContain("decide_approval");

    const current = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const context = await rpc("approval-context", "tools/call", { name: "get_task_context", arguments: {} });
    expect(context.result?.isError).not.toBe(true);
    const taskContext = JSON.parse(context.result!.content![0]!.text) as { executionStage?: Record<string, unknown> };
    expect(taskContext.executionStage).toMatchObject({
      stageId: approvalStageId,
      stageType: "approval",
      statusVersion: current.statusVersion,
      revision: current.revision,
      lastDecisionId: previousDecisionId,
    });
    const summary = "The worker must add the missing acceptance evidence.";
    const decision = await rpc("approval-decision", "tools/call", {
      name: "decide_issue_approval_stage",
      arguments: {
        decision: "request_changes", summary,
        expectedStageId: approvalStageId,
        expectedStatusVersion: current.statusVersion,
        expectedRevision: current.revision,
        expectedLastDecisionId: previousDecisionId,
      },
    });
    expect(decision.result?.isError).not.toBe(true);
    const rows = await server.db.select().from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.companyId, fixture.companyId),
      eq(issueExecutionDecisions.issueId, fixture.issueId),
      eq(issueExecutionDecisions.stageId, approvalStageId),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stageType: "approval", actorAgentId: fixture.agentId,
      createdByRunId: fixture.runId, outcome: "changes_requested",
    });
    expect(rows[0]!.body).toContain(summary);
    const updated = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    expect(updated).toMatchObject({ status: "in_progress", assigneeAgentId: workerId });
    expect(updated.executionState).toMatchObject({
      status: "changes_requested", lastDecisionId: rows[0]!.id, changesRequestedCount: 1,
    });
    const run = (await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)))[0]!;
    expect(run.status).toBe("running");
    const companyRuns = await server.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixture.companyId));
    expect(companyRuns).toEqual([{ id: fixture.runId }]);
  });

  it("approves the final stage without cancelling the deciding run", async () => {
    const current = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const result = await rpc("approve", "tools/call", { name: "decide_issue_approval_stage", arguments: {
      decision: "approve", summary: "All acceptance evidence is present.",
      expectedStageId: approvalStageId, expectedStatusVersion: current.statusVersion,
      expectedRevision: current.revision, expectedLastDecisionId: previousDecisionId,
    } });
    expect(result.result?.isError).not.toBe(true);
    const [decision] = await server.db.select().from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.issueId, fixture.issueId), eq(issueExecutionDecisions.stageId, approvalStageId),
    ));
    expect(decision).toMatchObject({ stageType: "approval", outcome: "approved", actorAgentId: fixture.agentId, createdByRunId: fixture.runId });
    const [updated] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(updated?.status).toBe("done");
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run?.status).toBe("running");
  });

  it.each(["null", "undefined"])("normalizes a provider %s sentinel for a first approval decision", async (sentinel) => {
    const [issue] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    await server.db.update(issues).set({ executionState: {
      ...(issue!.executionState as Record<string, unknown>), lastDecisionId: null,
      lastDecisionOutcome: null,
    } }).where(eq(issues.id, fixture.issueId));
    const current = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const malformed = await rpc(`bad-null-sentinel-${sentinel}`, "tools/call", { name: "decide_issue_approval_stage", arguments: {
      decision: "approve", summary: "First approval stage accepted.", expectedStageId: approvalStageId,
      expectedStatusVersion: current.statusVersion, expectedRevision: current.revision,
      expectedLastDecisionId: "not-a-uuid",
    } });
    expect(malformed.result?.isError).toBe(true);
    const [before] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect((before?.resultJson as Record<string, unknown>)?.approvalStageAttempts).toBeUndefined();
    const verdict = await rpc(`null-sentinel-${sentinel}`, "tools/call", { name: "decide_issue_approval_stage", arguments: {
      decision: "approve", summary: "First approval stage accepted.", expectedStageId: approvalStageId,
      expectedStatusVersion: current.statusVersion, expectedRevision: current.revision,
      expectedLastDecisionId: sentinel,
    } });
    expect(verdict.result?.isError).not.toBe(true);
    const [decision] = await server.db.select().from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.issueId, fixture.issueId), eq(issueExecutionDecisions.stageId, approvalStageId),
    ));
    expect(decision?.outcome).toBe("approved");
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    const attempts = (run?.resultJson as { approvalStageAttempts?: Record<string,
      { input?: { expectedLastDecisionId?: string | null } }> })?.approvalStageAttempts;
    expect(attempts?.[approvalStageId]?.input?.expectedLastDecisionId).toBeNull();
  });

  it("does not reserve an approval decision when its trusted API origin is absent", async () => {
    const current = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const args = { decision: "approve", summary: "Approved after verification.",
      expectedStageId: approvalStageId, expectedStatusVersion: current.statusVersion,
      expectedRevision: current.revision, expectedLastDecisionId: previousDecisionId };
    vi.stubEnv("PAPERCLIP_API_URL", "");
    try {
      const unavailable = await rpc("missing-api-origin", "tools/call", {
        name: "decide_issue_approval_stage", arguments: args,
      });
      expect(unavailable.result?.isError).toBe(true);
      const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      expect((run?.resultJson as Record<string, unknown>)?.approvalStageAttempts).toBeUndefined();
      expect(await server.db.select().from(issueExecutionDecisions).where(and(
        eq(issueExecutionDecisions.issueId, fixture.issueId), eq(issueExecutionDecisions.stageId, approvalStageId),
      ))).toHaveLength(0);
    } finally { vi.stubEnv("PAPERCLIP_API_URL", server.apiUrl); }
    const retry = await rpc("origin-restored", "tools/call", { name: "decide_issue_approval_stage", arguments: args });
    expect(retry.result?.isError).not.toBe(true);
  });

  it("rejects extra input, stale CAS, other actor, stage, and run before recording a decision", async () => {
    const current = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const valid = { decision: "approve", summary: "Approved after verification.",
      expectedStageId: approvalStageId, expectedStatusVersion: current.statusVersion,
      expectedRevision: current.revision, expectedLastDecisionId: previousDecisionId };
    const token = createLocalAgentJwt(fixture.agentId, fixture.companyId, "paperclip_runner", fixture.runId)!;
    const post = async (body: object, auth = token) => fetch(`${server.apiUrl}/api/issues/${fixture.issueId}/approval-stage-decisions`, {
      method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await post({ ...valid, unexpected: true })).status).toBe(400);
    expect((await post({ ...valid, expectedStatusVersion: current.statusVersion + 1 })).status).toBe(409);
    expect((await post({ ...valid, expectedRevision: current.revision + 1 })).status).toBe(409);
    expect((await post({ ...valid, expectedStageId: randomUUID() })).status).toBe(409);
    const otherActor = createLocalAgentJwt(workerId, fixture.companyId, "paperclip_runner", fixture.runId)!;
    expect((await post(valid, otherActor)).status).not.toBe(200);
    const otherRunId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: otherRunId, companyId: fixture.companyId, agentId: fixture.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: fixture.issueId,
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: fixture.issueId } });
    const otherRun = createLocalAgentJwt(fixture.agentId, fixture.companyId, "paperclip_runner", otherRunId)!;
    expect((await post(valid, otherRun)).status).toBe(409);
    for (const status of ["paused", "error"] as const) {
      await server.db.update(agents).set({ status }).where(eq(agents.id, fixture.agentId));
      expect((await post(valid)).status).not.toBe(200);
    }
    await server.db.update(agents).set({ status: "active" }).where(eq(agents.id, fixture.agentId));
    await server.db.update(issues).set({ workMode: "planning" }).where(eq(issues.id, fixture.issueId));
    expect((await post(valid)).status).toBe(409);
    await server.db.update(issues).set({ workMode: "standard" }).where(eq(issues.id, fixture.issueId));
    const rows = await server.db.select().from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.issueId, fixture.issueId), eq(issueExecutionDecisions.stageId, approvalStageId),
    ));
    expect(rows).toHaveLength(0);
    const [after] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(after?.status).toBe("in_review");
    expect(after?.executionState).toMatchObject({ status: "pending", currentStageId: approvalStageId });
  });

  it("recovers commit then 503 for same and different call IDs without another POST", async () => {
    const current = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const args = { decision: "request_changes", summary: "Provide the missing run evidence.",
      expectedStageId: approvalStageId, expectedStatusVersion: current.statusVersion,
      expectedRevision: current.revision, expectedLastDecisionId: previousDecisionId };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    let posted = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, options) => {
      if (typeof resource === "string" && resource.endsWith(`/api/issues/${fixture.issueId}/approval-stage-decisions`) && options?.method === "POST") {
        posted += 1;
        const committed = await nativeFetch(resource, options);
        expect(committed.status).toBe(200);
        return new Response("response lost after commit", { status: 503 });
      }
      return nativeFetch(resource, options);
    });
    try {
      for (const callId of ["lost-first", "lost-first", "lost-second"]) {
        const result = await rpc(callId, "tools/call", { name: "decide_issue_approval_stage", arguments: args });
        expect(result.result?.isError).not.toBe(true);
      }
      expect(posted).toBe(1);
      const rows = await server.db.select().from(issueExecutionDecisions).where(and(
        eq(issueExecutionDecisions.issueId, fixture.issueId), eq(issueExecutionDecisions.stageId, approvalStageId),
      ));
      expect(rows).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it("rejects an active or pending goal before reserving a verdict", async () => {
    const current = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const args = { decision: "approve", summary: "The verification is complete.",
      expectedStageId: approvalStageId, expectedStatusVersion: current.statusVersion,
      expectedRevision: current.revision, expectedLastDecisionId: previousDecisionId };
    const [session] = await server.db.insert(agentTaskSessions).values({ companyId: fixture.companyId,
      agentId: fixture.agentId, adapterType: "paperclip_runner", taskKey: fixture.issueId,
      goalJson: { objective: "Continue work", status: "active" },
    }).returning();
    const active = await rpc("goal-active", "tools/call", { name: "decide_issue_approval_stage", arguments: args });
    expect(active.result?.isError).toBe(true);
    await server.db.update(agentTaskSessions).set({ goalJson: { objective: "Continue work", status: "complete" } })
      .where(eq(agentTaskSessions.id, session!.id));
    await server.db.insert(agentSessionGoalActions).values({ companyId: fixture.companyId,
      sessionId: session!.id, requestId: randomUUID(), action: "pause", payloadJson: {}, status: "pending" });
    const pending = await rpc("goal-pending", "tools/call", { name: "decide_issue_approval_stage", arguments: args });
    expect(pending.result?.isError).toBe(true);
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect((run?.resultJson as Record<string, unknown> | null)?.approvalStageAttempts).toBeUndefined();
    const rows = await server.db.select().from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.issueId, fixture.issueId), eq(issueExecutionDecisions.stageId, approvalStageId),
    ));
    expect(rows).toHaveLength(0);
  });

  it("denies the approval receiver through generic call_api", async () => {
    expect(runnerApiRestriction("POST", "/api/issues/{id}/approval-stage-decisions")).not.toBeNull();
    const attempt = await rpc("generic-approval", "tools/call", { name: "call_api", arguments: {
      operationId: "POST /api/issues/{id}/approval-stage-decisions", pathParams: { id: fixture.issueId },
      body: { decision: "approve" },
    } });
    expect(attempt.result?.isError).toBe(true);
    const rows = await server.db.select().from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.issueId, fixture.issueId), eq(issueExecutionDecisions.stageId, approvalStageId),
    ));
    expect(rows).toHaveLength(0);
  });

  it("serializes concurrent call IDs so only the reservation creator posts", async () => {
    const current = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const args = { decision: "request_changes", summary: "Attach evidence before approval.",
      expectedStageId: approvalStageId, expectedStatusVersion: current.statusVersion,
      expectedRevision: current.revision, expectedLastDecisionId: previousDecisionId };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    let posted = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, options) => {
      if (typeof resource === "string" && resource.endsWith(`/api/issues/${fixture.issueId}/approval-stage-decisions`) && options?.method === "POST") posted += 1;
      return nativeFetch(resource, options);
    });
    try {
      const parallel = await Promise.all(["parallel-one", "parallel-two"].map((id) =>
        rpc(id, "tools/call", { name: "decide_issue_approval_stage", arguments: args })));
      expect(parallel.some((result) => result.result?.isError !== true)).toBe(true);
      const replay = await rpc("parallel-three", "tools/call", { name: "decide_issue_approval_stage", arguments: args });
      expect(replay.result?.isError).not.toBe(true);
      expect(posted).toBe(1);
      const decisions = await server.db.select().from(issueExecutionDecisions).where(and(
        eq(issueExecutionDecisions.issueId, fixture.issueId), eq(issueExecutionDecisions.stageId, approvalStageId),
      ));
      expect(decisions).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it("keeps a definite 409 in history and admits a fresh version with a new call ID", async () => {
    const initial = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const firstArgs = { decision: "approve", summary: "Verified for approval.", expectedStageId: approvalStageId,
      expectedStatusVersion: initial.statusVersion, expectedRevision: initial.revision,
      expectedLastDecisionId: previousDecisionId };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    let posted = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, options) => {
      if (typeof resource === "string" && resource.endsWith(`/api/issues/${fixture.issueId}/approval-stage-decisions`) && options?.method === "POST") {
        posted += 1;
        if (posted === 1) return new Response("prewrite conflict", { status: 409 });
      }
      return nativeFetch(resource, options);
    });
    try {
      expect((await rpc("definite-old", "tools/call", { name: "decide_issue_approval_stage", arguments: firstArgs })).result?.isError).toBe(true);
      expect((await rpc("definite-old", "tools/call", { name: "decide_issue_approval_stage", arguments: firstArgs })).result?.isError).toBe(true);
      expect(posted).toBe(1);
      await server.db.update(issues).set({ title: "Revised evidence" }).where(eq(issues.id, fixture.issueId));
      const freshContext = await rpc("definite-context", "tools/call", { name: "get_task_context", arguments: {} });
      const stage = (JSON.parse(freshContext.result!.content![0]!.text) as { executionStage: Record<string, unknown> }).executionStage;
      const freshArgs = { ...firstArgs, expectedRevision: stage.revision as number };
      const decided = await rpc("definite-new", "tools/call", { name: "decide_issue_approval_stage", arguments: freshArgs });
      expect(decided.result?.isError).not.toBe(true);
      expect(posted).toBe(2);
      const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      const history = (run?.resultJson as { approvalStageAttemptHistory?: Array<{ callId: string; failureStatus: number }> }).approvalStageAttemptHistory;
      expect(history).toContainEqual(expect.objectContaining({ callId: "definite-old", failureStatus: 409 }));
      const decisions = await server.db.select().from(issueExecutionDecisions).where(and(
        eq(issueExecutionDecisions.issueId, fixture.issueId), eq(issueExecutionDecisions.stageId, approvalStageId),
      ));
      expect(decisions).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it("never resends an unknown 503 even after a fresh version and call ID", async () => {
    const initial = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const firstArgs = { decision: "approve", summary: "The result needs approval.", expectedStageId: approvalStageId,
      expectedStatusVersion: initial.statusVersion, expectedRevision: initial.revision,
      expectedLastDecisionId: previousDecisionId };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    let posted = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, options) => {
      if (typeof resource === "string" && resource.endsWith(`/api/issues/${fixture.issueId}/approval-stage-decisions`) && options?.method === "POST") {
        posted += 1;
        return new Response("uncertain", { status: 503 });
      }
      return nativeFetch(resource, options);
    });
    try {
      expect((await rpc("unknown-old", "tools/call", { name: "decide_issue_approval_stage", arguments: firstArgs })).result?.isError).toBe(true);
      await server.db.update(issues).set({ title: "Fresh issue version" }).where(eq(issues.id, fixture.issueId));
      const freshContext = await rpc("unknown-context", "tools/call", { name: "get_task_context", arguments: {} });
      const stage = (JSON.parse(freshContext.result!.content![0]!.text) as { executionStage: Record<string, unknown> }).executionStage;
      expect((await rpc("unknown-new", "tools/call", { name: "decide_issue_approval_stage", arguments: {
        ...firstArgs, expectedRevision: stage.revision,
      } })).result?.isError).toBe(true);
      expect(posted).toBe(1);
      const rows = await server.db.select().from(issueExecutionDecisions).where(and(
        eq(issueExecutionDecisions.issueId, fixture.issueId), eq(issueExecutionDecisions.stageId, approvalStageId),
      ));
      expect(rows).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });

  it("keeps a later worker lease and decision through the actual same-run finalizer and replay", async () => {
    const initial = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const summary = "The worker must supply the missing verification artifact.";
    const verdict = await rpc("formal-before-finish", "tools/call", { name: "decide_issue_approval_stage", arguments: {
      decision: "request_changes", summary, expectedStageId: approvalStageId,
      expectedStatusVersion: initial.statusVersion, expectedRevision: initial.revision,
      expectedLastDecisionId: previousDecisionId,
    } });
    expect(verdict.result?.isError).not.toBe(true);
    const [original] = await server.db.select().from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.issueId, fixture.issueId), eq(issueExecutionDecisions.stageId, approvalStageId),
    ));
    expect(original).toMatchObject({ companyId: fixture.companyId, issueId: fixture.issueId,
      stageType: "approval", actorAgentId: fixture.agentId, createdByRunId: fixture.runId,
      outcome: "changes_requested", body: summary });

    const contractId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
    const contractSha = `approval-contract-${contractId}`;
    const contract = { revision: "approval-finish-v1", objective: "Finish the assigned approval",
      criteria: [{ id: "objective", requirement: "Record the formal approval decision" }] };
    await server.db.insert(completionContracts).values({ id: contractId, companyId: fixture.companyId,
      issueId: fixture.issueId, revision: 1, schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: contract,
      canonicalSha256: contractSha, createdByActorType: "system", createdByActorId: "test" });
    await server.db.update(heartbeatRuns).set({ nativeSessionId: sessionId, runnerInstanceId,
      completionContractId: contractId, completionContractSha256: contractSha })
      .where(eq(heartbeatRuns.id, fixture.runId));
    const port = new PaperclipControlPlanePort(server.db, { companyId: fixture.companyId,
      issueId: fixture.issueId, runId: fixture.runId, agentId: fixture.agentId, sessionId,
      completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerInstanceId, controlPlaneSourceInstanceId: "approval-test-control" });
    await port.openRun({ identity: { companyId: fixture.companyId, issueId: fixture.issueId,
      runId: fixture.runId, agentId: fixture.agentId, sessionId },
      backendKind: "mock", sourceInstanceId: runnerInstanceId });
    const workProductId = randomUUID(), evidenceRef = `work_product:${workProductId}`;
    await server.db.insert(issueWorkProducts).values({ id: workProductId, companyId: fixture.companyId,
      issueId: fixture.issueId, type: "artifact", provider: "paperclip", title: "Synthetic approval evidence",
      status: "ready_for_review", reviewState: "approved", createdByRunId: fixture.runId });
    const result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
    result.completionClaim.contractRevision = contract.revision;
    result.completionClaim.criteria[0]!.evidenceRefs = [evidenceRef];
    result.evidence = [{ kind: "work_product", ref: evidenceRef }];
    result.verification[0]!.artifactRef = evidenceRef;
    const assessed = await classifyNativeEvidence({ db: server.db, companyId: fixture.companyId,
      issueId: fixture.issueId, runId: fixture.runId, contract, result: result as unknown as Record<string, unknown> });
    expect(assessed).toMatchObject({ objectiveSatisfied: true, allCriteriaSatisfied: true,
      verificationPassed: true, hasFailedVerification: false, hasBlockingRemainingWork: false });

    const successorRunId = randomUUID(), laterStageId = randomUUID(), laterDecisionId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: successorRunId, companyId: fixture.companyId,
      agentId: workerId, status: "running", runtimeMode: "native", nativeIssueId: fixture.issueId,
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: fixture.issueId } });
    await server.db.insert(issueExecutionDecisions).values({ id: laterDecisionId, companyId: fixture.companyId,
      issueId: fixture.issueId, stageId: laterStageId, stageType: "review", actorAgentId: workerId,
      createdByRunId: successorRunId, outcome: "approved", body: "Later stage advanced." });
    await server.db.update(issues).set({ status: "in_review", assigneeAgentId: workerId,
      checkoutRunId: successorRunId, executionRunId: successorRunId,
      executionAgentNameKey: "later-worker", executionLockedAt: new Date(),
      executionState: { status: "pending", currentStageId: laterStageId,
        currentStageType: "review", lastDecisionId: laterDecisionId, lastDecisionOutcome: "approved" },
    }).where(eq(issues.id, fixture.issueId));
    const [baseline] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    const complete = { result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: "approval-finish-run" };
    await port.completeRun(complete);
    const [accepted] = await server.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, fixture.runId));
    const [coordinatorBefore] = await server.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(accepted?.schemaStatus).toBe("accepted");
    expect(coordinatorBefore?.phase).toBe("workspace_finalizing");
    await finalizeNativeRun({ db: server.db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    await port.completeRun(complete);
    await finalizeNativeRun({ db: server.db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [after] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    for (const key of ["status", "statusVersion", "revision", "assigneeAgentId", "assigneeUserId",
      "executionRunId", "checkoutRunId", "executionAgentNameKey", "executionLockedAt", "lastStatusDecisionId"] as const) {
      expect(after?.[key], key).toEqual(baseline?.[key]);
    }
    expect(after?.executionState).toEqual(baseline?.executionState);
    const [sourceRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    const [successor] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorRunId));
    expect(sourceRun?.status).toBe("succeeded");
    expect(successor?.status).toBe("running");
    const [decision] = await server.db.select().from(statusDecisions).where(eq(statusDecisions.runId, fixture.runId));
    expect(decision?.reasonCode).toBe("formal_approval_decision_recorded");
    expect(await server.db.select().from(statusDecisions).where(eq(statusDecisions.runId, fixture.runId))).toHaveLength(1);
    expect(await server.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, fixture.runId))).toHaveLength(1);
    expect((await server.db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.id, original!.id)))[0]?.body).toBe(summary);
    expect((await server.db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.id, laterDecisionId)))[0]?.body).toBe("Later stage advanced.");
  }, 30_000);
});
