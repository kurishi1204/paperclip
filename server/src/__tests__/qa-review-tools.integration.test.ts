import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issueExecutionDecisions, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

describe("run-bound QA review MCP", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    server = await startRunnerApiTestServer();
    vi.stubEnv("PAPERCLIP_API_URL", server.apiUrl);
  }, 90_000);
  afterAll(async () => { await server?.close(); vi.unstubAllEnvs(); });

  async function reviewFixture() {
    const fixture = await server.fixture();
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
    const token = createLocalAgentJwt(fixture.agentId, fixture.companyId, "paperclip_runner", fixture.runId)!;
    const call = async (method: string, params?: object) => {
      const response = await fetch(`${server.apiUrl}/api/mcp/qa-review`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      });
      return { status: response.status, body: await response.json() };
    };
    const tool = (name: string, args: object = {}) => call("tools/call", { name, arguments: args });
    const rows = () => server.db.select().from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.companyId, fixture.companyId),
      eq(issueExecutionDecisions.issueId, fixture.issueId),
    ));
    return { fixture, stageId, token, call, tool, rows };
  }

  it("exposes only issue-bound read and formal decision tools", async () => {
    const { fixture, token, call, tool } = await reviewFixture();
    expect((await call("tools/list")).body.result.tools.map((item: { name: string }) => item.name)).toEqual([
      "read_assigned_issue", "list_assigned_issue_comments", "submit_review_decision",
    ]);
    const issue = await tool("read_assigned_issue");
    expect(issue.body.result.structuredContent).toMatchObject({ id: fixture.issueId, title: "Verify runner API tools" });
    expect((await tool("list_assigned_issue_comments")).body.result.structuredContent).toMatchObject({ comments: [] });
    for (const args of [{ issueId: fixture.blockerId }, { companyId: fixture.foreignCompanyId }]) {
      expect((await tool("read_assigned_issue", args)).body.result.isError).toBe(true);
    }
    expect((await tool("unknown_tool")).body.result.isError).toBe(true);
    const unauthenticated = await fetch(`${server.apiUrl}/api/mcp/qa-review`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unauthenticated.status).toBe(403);
    expect(token).toBeTruthy();
  });

  it("records one exact review decision and rejects stale replay", async () => {
    const { fixture, stageId, tool, rows } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const args = {
      decision: "approve", summary: "QA evidence and acceptance checks passed.",
      expectedStageId: stageId, expectedStatusVersion: issue.statusVersion,
      expectedLastDecisionId: null,
    };
    const approval = await tool("submit_review_decision", args);
    expect(approval.body.result.isError).not.toBe(true);
    expect(approval.body.result.structuredContent).toMatchObject({ issueId: fixture.issueId, decisionOutcome: "approved" });
    expect(await rows()).toEqual([expect.objectContaining({
      issueId: fixture.issueId, stageId, actorAgentId: fixture.agentId, outcome: "approved",
    })]);
    expect((await tool("submit_review_decision", args)).status).toBe(403);
    expect(await rows()).toHaveLength(1);
  });

  it("records a changes-requested decision through the same formal issue route", async () => {
    const { fixture, stageId, tool, rows } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const decision = await tool("submit_review_decision", {
      decision: "request_changes", summary: "The source evidence is missing.",
      expectedStageId: stageId, expectedStatusVersion: issue.statusVersion,
      expectedLastDecisionId: null,
    });
    expect(decision.body.result.isError).not.toBe(true);
    expect(decision.body.result.structuredContent).toMatchObject({
      issueId: fixture.issueId, status: "in_progress", decisionOutcome: "changes_requested",
    });
    expect(await rows()).toEqual([expect.objectContaining({
      issueId: fixture.issueId, stageId, actorAgentId: fixture.agentId, outcome: "changes_requested",
    })]);
  });

  it("rejects stale version and loses authority when the run or assignment ends", async () => {
    const { fixture, stageId, tool, rows } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const args = {
      decision: "request_changes", summary: "The source evidence is missing.",
      expectedStageId: stageId, expectedStatusVersion: issue.statusVersion + 1,
      expectedLastDecisionId: null,
    };
    expect((await tool("submit_review_decision", args)).body.result.isError).toBe(true);
    expect(await rows()).toHaveLength(0);
    await server.db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, fixture.issueId));
    expect((await tool("read_assigned_issue")).status).toBe(403);
    await server.db.update(issues).set({ assigneeAgentId: fixture.agentId }).where(eq(issues.id, fixture.issueId));
    await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, fixture.runId));
    expect((await tool("read_assigned_issue")).status).toBe(403);
  });
});
