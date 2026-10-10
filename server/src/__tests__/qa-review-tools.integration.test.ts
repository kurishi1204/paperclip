import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { assets, documents, heartbeatRuns, issueAttachments, issueComments, issueExecutionDecisions, issues } from "@paperclipai/db";
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
      "read_assigned_issue", "list_assigned_issue_comments", "read_assigned_issue_document",
      "list_assigned_issue_attachments", "read_assigned_issue_attachment_text", "submit_review_decision",
    ]);
    const issue = await tool("read_assigned_issue");
    expect(issue.body.result.structuredContent).toMatchObject({ id: fixture.issueId, title: "Verify runner API tools" });
    expect((await tool("list_assigned_issue_comments", {
      expectedRevision: issue.body.result.structuredContent.revision,
    })).body.result.structuredContent).toMatchObject({ comments: [] });
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

  it("reads bounded non-plan document pages only through the assigned issue", async () => {
    const { fixture, tool } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const expectedRevision = issue.revision;
    expect(issue.documentSummaries).toEqual(expect.arrayContaining([expect.objectContaining({ key: "notes" })]));
    const first = (await tool("read_assigned_issue_document", { key: "notes", expectedRevision, limit: 12 })).body.result.structuredContent;
    expect(first).toMatchObject({ key: "notes", body: "Document ver", offset: 0, nextOffset: 12 });
    const second = (await tool("read_assigned_issue_document", {
      key: "notes", expectedRevision, offset: first.nextOffset, limit: 12,
    })).body.result.structuredContent;
    expect(second.body).toBe("ification co");
    expect((await tool("read_assigned_issue_document", { key: "../secrets", expectedRevision })).body.result.isError).toBe(true);
    expect((await tool("read_assigned_issue_document", { key: "notes", issueId: fixture.blockerId, expectedRevision })).body.result.isError).toBe(true);
    expect((await tool("read_assigned_issue_document", { key: "other-issue-only", expectedRevision })).body.result.isError).toBe(true);
    expect((await tool("read_assigned_issue_document", { key: "notes", expectedRevision, limit: 16_001 })).body.result.isError).toBe(true);
    const noteId = issue.documentSummaries.find((item: { key: string }) => item.key === "notes")?.id;
    await server.db.update(documents).set({ latestBody: "Updated acceptance evidence." }).where(eq(documents.id, noteId));
    expect((await tool("read_assigned_issue_document", { key: "notes", expectedRevision })).body.result.isError).toBe(true);
  });

  it("lists assigned attachments and reads only bounded text content", async () => {
    const { fixture, tool } = await reviewFixture();
    async function attach(issueId: string, contentType: string, name: string, body: Buffer) {
      const stored = await server.storage.putFile({
        companyId: fixture.companyId, namespace: "qa-evidence", originalFilename: name,
        contentType, body,
      });
      const [asset] = await server.db.insert(assets).values({ companyId: fixture.companyId, ...stored }).returning();
      const [attachment] = await server.db.insert(issueAttachments).values({
        companyId: fixture.companyId, issueId, assetId: asset!.id,
      }).returning();
      return attachment!.id;
    }
    const body = Buffer.from("QA evidence is ready and remains scoped to this issue.", "utf8");
    const assignedId = await attach(fixture.issueId, "text/plain", "evidence.txt", body);
    const binaryId = await attach(fixture.issueId, "application/pdf", "report.pdf", Buffer.from("%PDF-1.4"));
    const foreignId = await attach(fixture.blockerId, "text/plain", "foreign.txt", Buffer.from("Other issue data"));
    const expectedRevision = (await tool("read_assigned_issue")).body.result.structuredContent.revision;
    const listed = (await tool("list_assigned_issue_attachments", { expectedRevision, limit: 1 })).body.result.structuredContent;
    expect(listed).toMatchObject({ total: 2, offset: 0, nextOffset: 1 });
    expect(JSON.stringify(listed)).not.toContain("objectKey");
    const page = (await tool("read_assigned_issue_attachment_text", {
      attachmentId: assignedId, expectedRevision, limit: 8,
    })).body.result.structuredContent;
    expect(page).toMatchObject({ attachmentId: assignedId, text: "QA evide", offset: 0, nextOffset: 8, totalBytes: body.length });
    expect((await tool("read_assigned_issue_attachment_text", {
      attachmentId: assignedId, expectedRevision, offset: page.nextOffset, limit: 8,
    })).body.result.structuredContent.text).toBe("nce is r");
    expect((await tool("read_assigned_issue_attachment_text", { attachmentId: foreignId, expectedRevision })).body.result.isError).toBe(true);
    expect((await tool("read_assigned_issue_attachment_text", { attachmentId: binaryId, expectedRevision })).body.result.isError).toBe(true);
    expect((await tool("read_assigned_issue_attachment_text", { attachmentId: assignedId, expectedRevision, limit: 16_385 })).body.result.isError).toBe(true);
  });

  it("records one exact review decision and rejects stale replay", async () => {
    const { fixture, stageId, tool, rows } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const args = {
      decision: "approve", summary: "QA evidence and acceptance checks passed.",
      expectedStageId: stageId, expectedStatusVersion: issue.statusVersion, expectedRevision: issue.revision,
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
      expectedStageId: stageId, expectedStatusVersion: issue.statusVersion, expectedRevision: issue.revision,
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

  it("commits at most one decision when opposite QA verdicts race from one pending stage", async () => {
    const { fixture, stageId, tool, rows } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const expected = {
      expectedStageId: stageId,
      expectedStatusVersion: issue.statusVersion,
      expectedRevision: issue.revision,
      expectedLastDecisionId: null,
    };
    let approve!: Promise<Awaited<ReturnType<typeof tool>>>;
    let changes!: Promise<Awaited<ReturnType<typeof tool>>>;
    await server.db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, fixture.issueId)).for("update");
      approve = tool("submit_review_decision", {
        ...expected, decision: "approve", summary: "The evidence passed QA.",
      });
      changes = tool("submit_review_decision", {
        ...expected, decision: "request_changes", summary: "The evidence needs repair.",
      });
      await expect.poll(async () => {
        const blocked = await server.db.execute(sql<{ count: string }>`
          SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%issues%'
            AND query NOT LIKE '%pg_stat_activity%'
        `);
        return Number(blocked[0]?.count ?? 0);
      }, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    });
    const results = await Promise.all([approve, changes]);
    expect(results.filter((result) => result.body.result?.isError !== true)).toHaveLength(1);
    expect(results.filter((result) => result.body.result?.isError === true)).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  }, 45_000);

  it("rejects a verdict after a new issue comment changes the requirement", async () => {
    const { fixture, stageId, tool, rows } = await reviewFixture();
    const read = (await tool("read_assigned_issue")).body.result.structuredContent;
    expect((await tool("read_assigned_issue_document", {
      key: "notes", expectedRevision: read.revision,
    })).body.result.isError).not.toBe(true);
    await server.db.insert(issueComments).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      body: "A new acceptance requirement arrived after the QA read.",
    });
    const updated = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    expect(updated.statusVersion).toBe(read.statusVersion);
    expect(updated.revision).toBeGreaterThan(read.revision);
    expect((await tool("read_assigned_issue_document", {
      key: "notes", expectedRevision: read.revision,
    })).body.result.isError).toBe(true);
    const verdict = await tool("submit_review_decision", {
      decision: "approve", summary: "Only the earlier requirement was reviewed.",
      expectedStageId: stageId, expectedStatusVersion: read.statusVersion, expectedRevision: read.revision,
      expectedLastDecisionId: null,
    });
    expect(verdict.body.result.isError).toBe(true);
    expect(verdict.body.result.content[0].text).toContain("revision");
    expect(await rows()).toHaveLength(0);
  });

  it("checks the QA precondition in Issue PATCH and refuses mixed mutations", async () => {
    const { fixture, stageId, token, rows } = await reviewFixture();
    const issue = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const patch = (body: object) => fetch(`${server.apiUrl}/api/issues/${fixture.issueId}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const verdict = {
      status: "done", comment: "kind: review\ndecision: approved\nsummary: Verified.",
      qaReviewExpected: { stageId, statusVersion: issue.statusVersion + 1, revision: issue.revision, lastDecisionId: null },
    };
    expect((await patch(verdict)).status).toBe(409);
    expect((await patch({
      ...verdict, description: "An unrelated edit must not accompany the QA verdict.",
      qaReviewExpected: { ...verdict.qaReviewExpected, statusVersion: issue.statusVersion },
    })).status).toBe(403);
    expect(await rows()).toHaveLength(0);
  });

  it("rejects a stale requirement revision under the Issue PATCH row lock", async () => {
    const { fixture, stageId, token, rows } = await reviewFixture();
    const read = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    await server.db.insert(issueComments).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      body: "Another acceptance detail arrived before the verdict.",
    });
    const current = (await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    expect(current.statusVersion).toBe(read.statusVersion);
    expect(current.revision).toBeGreaterThan(read.revision);
    const response = await fetch(`${server.apiUrl}/api/issues/${fixture.issueId}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "done", comment: "kind: review\ndecision: approved\nsummary: Stale evidence.",
        qaReviewExpected: { stageId, statusVersion: read.statusVersion, revision: read.revision, lastDecisionId: null },
      }),
    });
    expect(response.status).toBe(409);
    expect(await rows()).toHaveLength(0);
  });

  it("preserves an ordinary Issue PATCH without a QA precondition", async () => {
    const { fixture, token, rows } = await reviewFixture();
    const response = await fetch(`${server.apiUrl}/api/issues/${fixture.issueId}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Ordinary issue update" }),
    });
    expect(response.status).toBe(200);
    expect((await server.db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]?.title)
      .toBe("Ordinary issue update");
    expect(await rows()).toHaveLength(0);
  });

  it("rejects stale version and loses authority when the run or assignment ends", async () => {
    const { fixture, stageId, tool, rows } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const args = {
      decision: "request_changes", summary: "The source evidence is missing.",
      expectedStageId: stageId, expectedStatusVersion: issue.statusVersion + 1, expectedRevision: issue.revision,
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
