import { randomUUID } from "node:crypto";
import http from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, assets, documentAnnotationComments, documentAnnotationThreads, documents, heartbeatRuns, issueAttachments, issueComments, issueExecutionDecisions, issueRelations, issues, issueWorkProducts } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { documentService } from "../services/documents.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { createWakeQueue } from "../modules/wake-queue/index.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import * as qaReviewTools from "../services/qa-review-tools.js";
import * as reviewProcesses from "@paperclipai/adapter-utils/server-utils";
import { HttpError } from "../errors.js";

it("requires the bound numeric loopback family for its bearer URL", () => {
  expect(qaReviewTools.qaReviewLocalApiUrl({
    PAPERCLIP_LISTEN_HOST: "localhost", PAPERCLIP_LISTEN_PORT: "3317",
  })).toBeNull();
  expect(qaReviewTools.qaReviewLocalApiUrl({
    PAPERCLIP_LISTEN_HOST: "::1", PAPERCLIP_LISTEN_PORT: "3317",
  })).toBe("http://[::1]:3317");
});

describe("run-bound QA review MCP", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    server = await startRunnerApiTestServer();
    vi.stubEnv("PAPERCLIP_API_URL", server.apiUrl);
  }, 90_000);
  afterAll(async () => {
    for (const running of reviewProcesses.runningProcesses.values()) {
      running.closed = true;
      for (const cleanup of running.closeCleanups ?? []) cleanup();
    }
    reviewProcesses.runningProcesses.clear();
    await server?.close(); vi.unstubAllEnvs();
  });

  async function reviewFixture(withResponsibleUser = false) {
    const fixture = await server.fixture(withResponsibleUser ? { connectionScenario: "fresh" } : {});
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
    // No OS process or provider is started by this fixture. Match the actual
    // review-only registry binding while retaining the old-source RED probe.
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
    const rows = () => server.db.select().from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.companyId, fixture.companyId),
      eq(issueExecutionDecisions.issueId, fixture.issueId),
    ));
    return { fixture, stageId, token, call, tool, rows };
  }

  it("preserves unbound Claude participant authority regardless of QA delivery configuration", async () => {
    for (const config of [
      { stored: false, override: true },
      { stored: true, override: false },
      { stored: true, override: undefined },
      { stored: false, override: undefined },
      { stored: "true", override: undefined },
    ]) {
      const { fixture, stageId, tool, rows } = await reviewFixture();
      await server.db.update(agents).set({ adapterType: "claude_local", adapterConfig: {
        engine: "cli", qaReviewToolsOnly: config.stored, dangerouslySkipPermissions: false,
      } }).where(eq(agents.id, fixture.agentId));
      if (config.override !== undefined) await server.db.update(issues).set({
        assigneeAdapterOverrides: { adapterConfig: { qaReviewToolsOnly: config.override } },
      }).where(eq(issues.id, fixture.issueId));
      reviewProcesses.runningProcesses.delete(fixture.runId);
      const read = await tool("read_assigned_issue");
      expect(read.body.result.isError).not.toBe(true);
      const issue = read.body.result.structuredContent;
      expect(issue.id).toBe(fixture.issueId);
      const verdict = await tool("submit_review_decision", {
        decision: "approve", summary: "Claude QA evidence checked.", expectedStageId: stageId,
        expectedStatusVersion: issue.statusVersion, expectedRevision: issue.revision,
        expectedLastDecisionId: issue.reviewStage.lastDecisionId,
      });
      expect(verdict.body.result.isError).not.toBe(true);
      const decisions = await rows();
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ createdByRunId: fixture.runId, actorAgentId: fixture.agentId });
    }
  });

  it("does not retain unbound Claude authority after the review assignee changes", async () => {
    const { fixture, tool, rows } = await reviewFixture();
    await server.db.update(agents).set({ adapterType: "claude_local", adapterConfig: { qaReviewToolsOnly: true } })
      .where(eq(agents.id, fixture.agentId));
    reviewProcesses.runningProcesses.delete(fixture.runId);
    expect((await tool("read_assigned_issue")).body.result.isError).not.toBe(true);
    await server.db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, fixture.issueId));
    for (const name of ["read_assigned_issue", "submit_review_decision"]) {
      expect((await tool(name)).status).toBe(403);
    }
    expect(await rows()).toHaveLength(0);
  });

  it("does not infer the unbound Claude exception from caller context or another adapter", async () => {
    for (const config of [
      { adapterType: "codex_local", adapterConfig: { qaReviewToolsOnly: true } },
      { adapterType: "paperclip_runner", adapterConfig: { qaReviewToolsOnly: true } },
    ]) {
      const { fixture, tool, rows } = await reviewFixture();
      await server.db.update(agents).set(config).where(eq(agents.id, fixture.agentId));
      await server.db.update(heartbeatRuns).set({ contextSnapshot: {
        issueId: fixture.issueId, adapterType: "claude_local", qaReviewToolsOnly: true,
      } }).where(eq(heartbeatRuns.id, fixture.runId));
      reviewProcesses.runningProcesses.delete(fixture.runId);
      const spy = vi.spyOn(qaReviewTools, "callQaReviewTool");
      try {
        for (const name of ["read_assigned_issue", "submit_review_decision"]) {
          const rejected = await tool(name);
          expect(rejected.body.result.isError).toBe(true);
          expect(JSON.stringify(rejected.body)).toContain("not bound");
        }
        expect(spy).not.toHaveBeenCalled();
        expect(await rows()).toHaveLength(0);
      } finally { spy.mockRestore(); }
    }
  });

  it("review regression rejects unknown tools before service or paging hold", async () => {
    const {fixture, tool, rows} = await reviewFixture(); const spy = vi.spyOn(qaReviewTools, "callQaReviewTool");
    try {
      for (let i=0;i<2;i++) { const r=await tool("unknown_tool"); expect(r.status).toBe(200);
        expect(r.body.result.isError).toBe(true); expect(JSON.stringify(r.body)).toContain("Unknown QA review tool"); }
      expect(spy.mock.calls.length).toBe(0); expect(await rows()).toHaveLength(0);
      const control=reviewProcesses.getQaReviewProcess(fixture.runId)!.control;
      expect(control.hold ?? control.requestedHold).toBeNull();
    } finally {spy.mockRestore();}
  });

  it("review regression rejects absent params with the existing unknown-tool contract", async () => {
    const {fixture, call, rows} = await reviewFixture(); const spy=vi.spyOn(qaReviewTools,"callQaReviewTool");
    try {
      const r=await call("tools/call"); expect(r.status).toBe(200); expect(r.body.result.isError).toBe(true);
      expect(JSON.stringify(r.body)).toContain("Unknown QA review tool");
      expect(spy.mock.calls.length).toBe(0); expect(await rows()).toHaveLength(0);
      const control=reviewProcesses.getQaReviewProcess(fixture.runId)!.control;
      expect(control.hold ?? control.requestedHold).toBeNull();
    } finally {spy.mockRestore();}
  });

  it("exposes only issue-bound read and formal decision tools", async () => {
    const { fixture, token, call, tool } = await reviewFixture();
    expect((await call("tools/list")).body.result.tools.map((item: { name: string }) => item.name)).toEqual([
      "read_assigned_issue", "list_assigned_issue_comments", "read_assigned_issue_document",
      "list_assigned_issue_attachments", "read_assigned_issue_attachment_text", "submit_review_decision",
      "read_assigned_issue_description", "list_assigned_issue_annotations", "read_assigned_review_receipt",
      "read_assigned_issue_comment", "read_assigned_issue_annotation_text",
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

  it("stops repeated invalid paging arguments after two observed errors, including parallel calls", async () => {
    const { fixture, tool } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const spy = vi.spyOn(qaReviewTools, "callQaReviewTool");
    try {
      const args = { commentId: randomUUID(), expectedRevision: issue.revision, limit: 8000 };
      const responses = await Promise.all(Array.from({ length: 8 }, () => tool("read_assigned_issue_comment", args)));
      expect(responses.every(v => v.body.result.isError)).toBe(true);
      expect(responses.some(v => JSON.stringify(v.body).includes("held"))).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
      const binding = reviewProcesses.getQaReviewProcess(fixture.runId)!;
      expect(binding.control.hold ?? binding.control.requestedHold).toMatchObject({
        reason: "qa_review_read_hold", runId: fixture.runId, issueId: fixture.issueId,
        companyId: fixture.companyId, agentId: fixture.agentId, statusVersion: issue.statusVersion,
      });
    } finally { spy.mockRestore(); }
  });

  it("preserves offset0 versus absent identity in the recorded c8 error sequence", async () => {
    const { tool } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const args = { commentId: randomUUID(), expectedRevision: issue.revision, limit: 8000 };
    const spy = vi.spyOn(qaReviewTools, "callQaReviewTool");
    try {
      await tool("read_assigned_issue_comment", { ...args, offset: 0 });
      await tool("read_assigned_issue_comment", args);
      await tool("read_assigned_issue_comment", args);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(JSON.stringify((await tool("read_assigned_issue")).body)).toContain("held");
      expect(spy).toHaveBeenCalledTimes(3);
    } finally { spy.mockRestore(); }
  });

  it("allows overview rereads and does not turn transient transport errors into a configuration hold", async () => {
    const { fixture, tool } = await reviewFixture();
    for (let i = 0; i < 3; i++) expect((await tool("read_assigned_issue")).body.result.isError).not.toBe(true);
    const spy = vi.spyOn(qaReviewTools, "callQaReviewTool");
    try {
      spy.mockRejectedValueOnce(new Error("ECONNRESET")).mockRejectedValueOnce(new Error("transport timeout"));
      await tool("read_assigned_issue"); await tool("read_assigned_issue");
      expect(reviewProcesses.getQaReviewProcess(fixture.runId)?.control.requestedHold).toBeNull();
      spy.mockRejectedValueOnce(new HttpError(409, "unchanged version conflict"));
      await tool("read_assigned_issue");
      expect((await tool("read_assigned_issue")).body.result.isError).not.toBe(true);
      expect(reviewProcesses.getQaReviewProcess(fixture.runId)?.control.requestedHold).toBeNull();
    } finally { spy.mockRestore(); }
  });

  it("holds actual unchanged paginated results on the third repeat but rejects missing review binding", async () => {
    const { fixture, tool } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const args = { expectedRevision: issue.revision };
    for (let i = 0; i < 2; i++) expect((await tool("list_assigned_issue_comments", args)).body.result.isError).not.toBe(true);
    expect((await tool("list_assigned_issue_comments", args)).body.result.isError).toBe(true);
    reviewProcesses.runningProcesses.delete(fixture.runId);
    expect(JSON.stringify((await tool("read_assigned_issue")).body)).toContain("not bound");
  });

  it("uses its accepted local listener for self-reads even when the public API URL is remote", async () => {
    const { fixture, tool } = await reviewFixture();
    vi.stubEnv("PAPERCLIP_API_URL", "https://public-paperclip.invalid");
    try {
      const read = await tool("read_assigned_issue");
      expect(read.body.result.isError).not.toBe(true);
      expect(read.body.result.structuredContent.id).toBe(fixture.issueId);
    } finally {
      vi.stubEnv("PAPERCLIP_API_URL", server.apiUrl);
    }
  });

  it("keeps MCP self GET, attachment GET and verdict PATCH off an ambient fetch proxy", async () => {
    const { fixture, stageId, token, rows } = await reviewFixture();
    const proxyHits: Array<{ authorization: string | undefined; url: string | undefined }> = [];
    const proxy = http.createServer((req, res) => {
      proxyHits.push({ authorization: req.headers.authorization, url: req.url });
      res.writeHead(502).end("proxy must not receive the QA JWT");
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as import("node:net").AddressInfo).port}`;
    const previousAgent = http.globalAgent;
    const poisonedAgent = new http.Agent({ proxyEnv: { HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY: "" } });
    http.globalAgent = poisonedAgent;
    const priorEnv = Object.fromEntries(["HTTP_PROXY", "ALL_PROXY", "NO_PROXY"].map(key => [key, process.env[key]]));
    process.env.HTTP_PROXY = proxyUrl;
    process.env.ALL_PROXY = proxyUrl;
    process.env.NO_PROXY = "";
    // Model a runtime configured to proxy global fetch. The MCP caller below
    // connects directly; only the server's internal self-request is probed.
    const fetchProxy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const header = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        const req = http.request(proxyUrl, { agent: false, headers: header ? { Authorization: header } : {} }, res => {
          res.resume();
          res.on("end", () => resolve(new Response(null, { status: res.statusCode ?? 502 })));
        });
        req.on("error", reject);
        req.end();
      });
    });
    const tool = async (name: string, args: object = {}) => {
      const payload = JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call",
        params: { name, arguments: args } });
      const url = new URL("/api/mcp/qa-review", server.apiUrl);
      return new Promise<any>((resolve, reject) => {
        const req = http.request(url, { method: "POST", agent: false, headers: {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        } }, res => {
          const chunks: Buffer[] = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
            catch (error) { reject(error); }
          });
        });
        req.on("error", reject);
        req.end(payload);
      });
    };
    try {
      const stored = await server.storage.putFile({ companyId: fixture.companyId,
        namespace: "qa-evidence", originalFilename: "proxy-proof.txt",
        contentType: "text/plain", body: Buffer.from("review proof") });
      const [asset] = await server.db.insert(assets).values({ companyId: fixture.companyId, ...stored }).returning();
      const [attachment] = await server.db.insert(issueAttachments).values({
        companyId: fixture.companyId, issueId: fixture.issueId, assetId: asset!.id,
      }).returning();
      const issue = (await tool("read_assigned_issue")).result;
      expect(issue.isError).not.toBe(true);
      const read = issue.structuredContent;
      const content = (await tool("read_assigned_issue_attachment_text", {
        attachmentId: attachment!.id, expectedRevision: read.revision, limit: 8,
      })).result;
      expect(content.isError).not.toBe(true);
      expect(content.structuredContent.text).toBe("review p");
      const verdict = (await tool("submit_review_decision", {
        decision: "approve", summary: "Local evidence checked.", expectedStageId: stageId,
        expectedStatusVersion: read.statusVersion, expectedRevision: read.revision,
        expectedLastDecisionId: read.reviewStage.lastDecisionId,
      })).result;
      expect(verdict.isError).not.toBe(true);
      expect(await rows()).toHaveLength(1);
      expect(fetchProxy).not.toHaveBeenCalled();
      expect(proxyHits).toEqual([]);
    } finally {
      fetchProxy.mockRestore();
      http.globalAgent = previousAgent;
      poisonedAgent.destroy();
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });

  it("projects the assigned issue without neighboring issue or project records", async () => {
    const { fixture, token, tool } = await reviewFixture();
    await server.db.update(issues).set({
      title: "Neighbor secret: scarlet-heron",
      description: "Neighbor body: copper-lynx",
    }).where(eq(issues.id, fixture.blockerId));
    await server.db.insert(issueRelations).values({
      companyId: fixture.companyId,
      issueId: fixture.blockerId,
      relatedIssueId: fixture.issueId,
      type: "blocks",
    });
    const rawResponse = await fetch(`${server.apiUrl}/api/issues/${fixture.issueId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(rawResponse.status).toBe(200);
    const raw = await rawResponse.json();
    expect(JSON.stringify(raw)).toContain("scarlet-heron");
    expect(JSON.stringify(raw)).toContain("violet-otter");

    const response = await tool("read_assigned_issue");
    expect(response.body.result.isError).not.toBe(true);
    const issue = response.body.result.structuredContent;
    expect(issue).toMatchObject({
      id: fixture.issueId,
      title: "Verify runner API tools",
      descriptionCharacters: "Fixture marker: amber-fox.".length,
      reviewStage: { stageId: expect.any(String), lastDecisionId: null },
      documentSummaries: expect.arrayContaining([expect.objectContaining({ key: "notes" })]),
    });
    expect(Object.keys(issue).sort()).toEqual([
      "descriptionCharacters", "documentSummaries", "id", "identifier", "legacyPlanDocument",
      "planDocument", "revision", "reviewStage", "status", "statusVersion",
      "title", "workMode", "workProducts",
    ].sort());
    expect(JSON.stringify(issue)).not.toMatch(/scarlet-heron|copper-lynx|violet-otter/);
    expect(JSON.stringify(issue)).not.toContain(fixture.blockerId);
    expect(JSON.stringify(issue)).not.toContain(fixture.projectId);
    expect((await tool("read_assigned_issue_description", {
      expectedRevision: issue.revision, limit: 15,
    })).body.result.structuredContent).toMatchObject({
      body: "Fixture marker:", offset: 0, nextOffset: 15,
    });
  });

  it("keeps a large plan body out of the issue overview and pages its content", async () => {
    const { fixture, tool } = await reviewFixture();
    const body = `Plan marker: topaz-marten. ${"P".repeat(30_000)}`;
    await documentService(server.db).upsertIssueDocument({
      issueId: fixture.issueId, key: "plan", title: "Acceptance plan",
      format: "markdown", body, baseRevisionId: null, changeSummary: null,
      createdByAgentId: fixture.agentId, createdByRunId: fixture.runId,
    });
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    expect(issue.planDocument).toMatchObject({ key: "plan", bodyCharacters: body.length });
    expect(JSON.stringify(issue)).not.toContain("topaz-marten");
    expect(JSON.stringify(issue).length).toBeLessThan(10_000);
    const page = (await tool("read_assigned_issue_document", {
      key: "plan", expectedRevision: issue.revision, limit: 16_000,
    })).body.result.structuredContent;
    expect(page.body).toBe(body.slice(0, 16_000));
    expect(page.nextOffset).toBe(16_000);
  });

  it("fails closed when assigned work-product metadata cannot fit the overview", async () => {
    const { fixture, tool } = await reviewFixture();
    await server.db.insert(issueWorkProducts).values({
      companyId: fixture.companyId, issueId: fixture.issueId,
      type: "artifact", provider: "paperclip", status: "ready",
      title: "W".repeat(100_000),
    });
    expect((await tool("read_assigned_issue")).body.result.isError).toBe(true);
  });

  it("rejects a verdict after the assigned work product changed", async () => {
    const { fixture, stageId, tool, rows } = await reviewFixture();
    const [product] = await server.db.insert(issueWorkProducts).values({
      companyId: fixture.companyId, issueId: fixture.issueId,
      type: "artifact", provider: "paperclip", status: "ready",
      title: "Acceptance evidence", url: "https://example.test/evidence-v1",
    }).returning();
    const before = (await tool("read_assigned_issue")).body.result.structuredContent;
    await server.db.update(issueWorkProducts).set({
      status: "closed", url: "https://example.test/evidence-v2",
    }).where(eq(issueWorkProducts.id, product!.id));
    const staleVerdict = await tool("submit_review_decision", {
      decision: "approve", summary: "Approved evidence v1.",
      expectedStageId: stageId, expectedStatusVersion: before.statusVersion,
      expectedRevision: before.revision,
      expectedLastDecisionId: before.reviewStage.lastDecisionId,
    });
    expect(staleVerdict.body.result.isError).toBe(true);
    expect(staleVerdict.body.result.content[0].text).toContain("re-read the issue");
    expect(staleVerdict.body.result.content[0].text).not.toContain("do not resubmit");
    expect(await rows()).toHaveLength(0);
    const after = (await tool("read_assigned_issue")).body.result.structuredContent;
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.workProducts).toEqual([expect.objectContaining({
      id: product!.id, status: "closed", url: "https://example.test/evidence-v2",
    })]);
  });

  it("ignores unprojected work-product refreshes but invalidates reviewer-visible evidence", async () => {
    const { fixture, tool } = await reviewFixture();
    const [product] = await server.db.insert(issueWorkProducts).values({
      companyId: fixture.companyId, issueId: fixture.issueId,
      type: "artifact", provider: "paperclip", status: "ready", title: "Evidence",
    }).returning();
    const before = (await tool("read_assigned_issue")).body.result.structuredContent;
    await server.db.update(issueWorkProducts).set({ updatedAt: new Date(Date.now() + 1_000) })
      .where(eq(issueWorkProducts.id, product!.id));
    const afterRefresh = (await tool("read_assigned_issue")).body.result.structuredContent;
    expect(afterRefresh.revision).toBe(before.revision);
    await server.db.update(issueWorkProducts).set({ metadata: { verdict: "new evidence" } })
      .where(eq(issueWorkProducts.id, product!.id));
    const afterMetadata = (await tool("read_assigned_issue")).body.result.structuredContent;
    expect(afterMetadata.revision).toBe(afterRefresh.revision);
    await server.db.update(issueWorkProducts).set({ status: "closed" })
      .where(eq(issueWorkProducts.id, product!.id));
    const afterEvidence = (await tool("read_assigned_issue")).body.result.structuredContent;
    expect(afterEvidence.revision).toBeGreaterThan(afterMetadata.revision);
  });

  it("treats a server error after a verdict request as outcome-unknown", async () => {
    const { fixture, stageId, token, tool, rows } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const [boundIssue] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    const requests: string[] = [];
    const failureServer = http.createServer((req, res) => {
      requests.push(req.method ?? "");
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "upstream failure" }));
    });
    await new Promise<void>((resolve, reject) => {
      failureServer.once("error", reject);
      failureServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      await expect(qaReviewTools.callQaReviewTool({
        db: server.db, runId: fixture.runId, companyId: fixture.companyId,
        agentId: fixture.agentId, token, issue: boundIssue!,
        apiUrl: `http://127.0.0.1:${(failureServer.address() as import("node:net").AddressInfo).port}`,
        name: "submit_review_decision", arguments: {
          decision: "approve", summary: "Evidence reviewed.", expectedStageId: stageId,
          expectedStatusVersion: issue.statusVersion, expectedRevision: issue.revision,
          expectedLastDecisionId: issue.reviewStage.lastDecisionId,
        },
      })).rejects.toBeInstanceOf(qaReviewTools.QaDecisionOutcomeUnknownError);
      expect(requests).toEqual(["PATCH"]);
      expect(await rows()).toHaveLength(0);
    } finally {
      await new Promise<void>(resolve => failureServer.close(() => resolve()));
    }
  });

  it("increments the issue requirement revision for work-product create and delete", async () => {
    const { fixture, tool } = await reviewFixture();
    const initial = (await tool("read_assigned_issue")).body.result.structuredContent.revision;
    const [product] = await server.db.insert(issueWorkProducts).values({
      companyId: fixture.companyId, issueId: fixture.issueId,
      type: "artifact", provider: "paperclip", status: "ready", title: "Temporary evidence",
    }).returning();
    const afterCreate = (await tool("read_assigned_issue")).body.result.structuredContent.revision;
    expect(afterCreate).toBeGreaterThan(initial);
    await server.db.delete(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id));
    expect(await server.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id))).toHaveLength(0);
    const afterDelete = (await tool("read_assigned_issue")).body.result.structuredContent.revision;
    expect(afterDelete).toBeGreaterThan(afterCreate);
  });

  it("invalidates a verdict after an attachment is added or removed", async () => {
    const { fixture, stageId, tool, rows } = await reviewFixture();
    const before = (await tool("read_assigned_issue")).body.result.structuredContent;
    const [attachment] = await server.db.insert(issueAttachments).values({
      companyId: fixture.companyId, issueId: fixture.issueId, assetId: fixture.artifactId,
    }).returning();
    const afterAdd = (await tool("read_assigned_issue")).body.result.structuredContent;
    expect(afterAdd.revision).toBeGreaterThan(before.revision);
    const verdict = (read: typeof before) => tool("submit_review_decision", {
      decision: "approve", summary: "Evidence was checked.", expectedStageId: stageId,
      expectedStatusVersion: read.statusVersion, expectedRevision: read.revision,
      expectedLastDecisionId: read.reviewStage.lastDecisionId,
    });
    expect((await verdict(before)).body.result.isError).toBe(true);
    await server.db.delete(issueAttachments).where(eq(issueAttachments.id, attachment!.id));
    const afterDelete = (await tool("read_assigned_issue")).body.result.structuredContent;
    expect(afterDelete.revision).toBeGreaterThan(afterAdd.revision);
    expect((await verdict(afterAdd)).body.result.isError).toBe(true);
    expect(await rows()).toHaveLength(0);
  });

  it("pages oversized Japanese comments without exposing raw metadata", async () => {
    const { fixture, tool } = await reviewFixture();
    await server.db.insert(issueComments).values({
      companyId: fixture.companyId, issueId: fixture.issueId,
      authorAgentId: fixture.agentId, body: "Assigned issue comment.",
      clientRequestId: "private-comment-request-marker",
    });
    const firstRevision = (await tool("read_assigned_issue")).body.result.structuredContent.revision;
    const first = (await tool("list_assigned_issue_comments", {
      expectedRevision: firstRevision,
    })).body.result.structuredContent;
    const [longComment] = await server.db.insert(issueComments).values({
      companyId: fixture.companyId, issueId: fixture.issueId,
      authorAgentId: fixture.agentId, body: "審査\\\"".repeat(6_000),
    }).returning();
    const secondRevision = (await tool("read_assigned_issue")).body.result.structuredContent.revision;
    const oversized = await tool("list_assigned_issue_comments", {
      expectedRevision: secondRevision,
    });
    expect(oversized.body.result.isError).not.toBe(true);
    const omitted = oversized.body.result.structuredContent.comments.find((item: { id: string }) => item.id === longComment!.id);
    expect(omitted).toMatchObject({ body: "", bodyOmitted: true });
    let offset = 0;
    let assembled = "";
    while (true) {
      const page = await tool("read_assigned_issue_comment", {
        commentId: longComment!.id, expectedRevision: secondRevision, offset,
      });
      expect(page.body.result.isError).not.toBe(true);
      expect(page.wireBytes).toBeLessThanOrEqual(64_000);
      assembled += page.body.result.structuredContent.text;
      if (page.body.result.structuredContent.nextOffset === null) break;
      offset = page.body.result.structuredContent.nextOffset;
    }
    expect(assembled).toBe("審査\\\"".repeat(6_000));
    expect((await tool("read_assigned_issue_comment", {
      commentId: randomUUID(), expectedRevision: secondRevision,
    })).body.result.isError).toBe(true);
    expect(first.comments).toEqual([expect.objectContaining({ body: "Assigned issue comment." })]);
    expect(JSON.stringify(first)).not.toContain("private-comment-request-marker");
  });

  it("pages large assigned comments without dropping the remaining comment", async () => {
    const { fixture, tool } = await reviewFixture();
    const [firstComment, secondComment] = await server.db.insert(issueComments).values([
      { companyId: fixture.companyId, issueId: fixture.issueId,
        authorAgentId: fixture.agentId, body: "あ".repeat(8_000), createdAt: new Date("2026-01-01T00:00:00Z") },
      { companyId: fixture.companyId, issueId: fixture.issueId,
        authorAgentId: fixture.agentId, body: "い".repeat(8_000), createdAt: new Date("2026-01-01T00:00:01Z") },
    ]).returning();
    const expectedRevision = (await tool("read_assigned_issue")).body.result.structuredContent.revision;
    const first = (await tool("list_assigned_issue_comments", { expectedRevision, limit: 1 })).body.result.structuredContent;
    expect(first.comments.map((comment: { id: string }) => comment.id)).toEqual([firstComment!.id]);
    expect(first.nextAfterCommentId).toBe(firstComment!.id);
    const second = (await tool("list_assigned_issue_comments", {
      expectedRevision, afterCommentId: first.nextAfterCommentId,
    })).body.result.structuredContent;
    expect(second.comments.map((comment: { id: string }) => comment.id)).toEqual([secondComment!.id]);
    expect(second.nextAfterCommentId).toBeNull();
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

  it("reads assigned-document annotations and rejects a stale annotation revision", async () => {
    const { fixture, tool } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const documentId = issue.documentSummaries.find((item: { key: string }) => item.key === "notes")?.id;
    const [doc] = await server.db.select().from(documents).where(eq(documents.id, documentId));
    const [thread] = await server.db.insert(documentAnnotationThreads).values({
      companyId: fixture.companyId, issueId: fixture.issueId, documentId,
      documentKey: "notes", originalRevisionNumber: doc!.latestRevisionNumber,
      currentRevisionNumber: doc!.latestRevisionNumber,
      selectedText: "Document", normalizedStart: 0, normalizedEnd: 8,
      markdownStart: 0, markdownEnd: 8,
      anchorSelector: {
        quote: { exact: "Document", prefix: "", suffix: "" },
        position: { normalizedStart: 0, normalizedEnd: 8, markdownStart: 0, markdownEnd: 8 },
      },
    }).returning();
    const [comment] = await server.db.insert(documentAnnotationComments).values({
      companyId: fixture.companyId, issueId: fixture.issueId,
      documentId, threadId: thread!.id,
      body: "Annotation requirement: verify the source before approval.", authorType: "agent",
      authorAgentId: fixture.agentId,
    }).returning();
    const current = (await tool("read_assigned_issue")).body.result.structuredContent;
    expect(current.revision).toBeGreaterThan(issue.revision);
    const args = { key: "notes", expectedRevision: current.revision, limit: 1 };
    const page = (await tool("list_assigned_issue_annotations", args)).body.result.structuredContent;
    expect(page).toMatchObject({ total: 1, offset: 0, nextOffset: null,
      annotations: [{ threadId: thread!.id, commentId: comment!.id,
        body: "Annotation requirement: verify the source before approval." }],
    });
    expect((await tool("list_assigned_issue_annotations", {
      key: "other-issue-only", expectedRevision: current.revision,
    })).body.result.isError).toBe(true);
    await server.db.update(documentAnnotationComments).set({
      body: "Changed annotation requirement.",
    }).where(eq(documentAnnotationComments.id, comment!.id));
    expect((await tool("list_assigned_issue_annotations", args)).body.result.isError).toBe(true);
    await server.db.update(documentAnnotationComments).set({
      body: "確認\\\"".repeat(6_000),
    }).where(eq(documentAnnotationComments.id, comment!.id));
    const oversizedRevision = (await tool("read_assigned_issue")).body.result.structuredContent.revision;
    const oversized = await tool("list_assigned_issue_annotations", {
      key: "notes", expectedRevision: oversizedRevision,
    });
    expect(oversized.body.result.isError).not.toBe(true);
    expect(oversized.body.result.structuredContent.annotations[0]).toMatchObject({
      commentId: comment!.id, bodyOmitted: true,
    });
    let annotationBody = "";
    let offset = 0;
    while (true) {
      const text = await tool("read_assigned_issue_annotation_text", {
        key: "notes", threadId: thread!.id, commentId: comment!.id,
        field: "body", expectedRevision: oversizedRevision, offset,
      });
      expect(text.body.result.isError).not.toBe(true);
      expect(text.wireBytes).toBeLessThanOrEqual(64_000);
      annotationBody += text.body.result.structuredContent.text;
      if (text.body.result.structuredContent.nextOffset === null) break;
      offset = text.body.result.structuredContent.nextOffset;
    }
    expect(annotationBody).toBe("確認\\\"".repeat(6_000));
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

  it("fails closed on a long assigned attachment name before it reaches the QA subprocess", async () => {
    const { fixture, tool } = await reviewFixture();
    const stored = await server.storage.putFile({
      companyId: fixture.companyId, namespace: "qa-evidence",
      originalFilename: "A".repeat(100_000), contentType: "text/plain", body: Buffer.from("evidence"),
    });
    const [asset] = await server.db.insert(assets).values({ companyId: fixture.companyId, ...stored }).returning();
    await server.db.insert(issueAttachments).values({
      companyId: fixture.companyId, issueId: fixture.issueId, assetId: asset!.id,
    });
    const expectedRevision = (await tool("read_assigned_issue")).body.result.structuredContent.revision;
    const response = await tool("list_assigned_issue_attachments", { expectedRevision });
    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.structuredContent).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("A".repeat(1_000));
    expect(response.wireBytes).toBeLessThanOrEqual(64_000);
  });

  it.each(qaReviewTools.QA_REVIEW_TOOL_NAMES)("caps the entire %s tools/call response", async (name) => {
    const { tool } = await reviewFixture();
    // The object alone fits; duplicated content.text + structuredContent does not.
    const executor = vi.spyOn(qaReviewTools, "callQaReviewTool").mockResolvedValue({ payload: "Z".repeat(35_000) });
    try {
      const response = await tool(name);
      expect(response.body.result.isError).toBe(true);
      expect(response.body.result.structuredContent).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain("Z".repeat(1_000));
      expect(response.wireBytes).toBeLessThanOrEqual(64_000);
      if (name === "submit_review_decision") {
        expect(response.body.result.content[0].text).toContain("read_assigned_review_receipt");
        expect(response.body.result.content[0].text).not.toMatch(/retry/i);
      }
    } finally {
      executor.mockRestore();
    }
  });

  it("replaces an oversized tool error message with a bounded generic error", async () => {
    const { tool } = await reviewFixture();
    const executor = vi.spyOn(qaReviewTools, "callQaReviewTool").mockRejectedValue(new Error("E".repeat(100_000)));
    try {
      const response = await tool("read_assigned_issue");
      expect(response.body.result.isError).toBe(true);
      expect(response.body.result.content[0].text).toBe("QA review tool failed");
      expect(response.wireBytes).toBeLessThanOrEqual(64_000);
    } finally {
      executor.mockRestore();
    }
  });

  it("bounds the JSON-RPC id even when the caller supplies an oversized value", async () => {
    const { token, tool } = await reviewFixture();
    const response = await tool("read_assigned_issue");
    expect(response.body.result.isError).not.toBe(true);
    const raw = await fetch(`${server.apiUrl}/api/mcp/qa-review`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "I".repeat(100_000), method: "tools/call",
        params: { name: "read_assigned_issue", arguments: {} } }),
    });
    const wire = await raw.text();
    const bounded = JSON.parse(wire);
    expect(bounded.id).toBeNull();
    expect(bounded.result.isError).toBe(true);
    expect(wire).not.toContain("I".repeat(1_000));
    expect(Buffer.byteLength(wire, "utf8")).toBeLessThanOrEqual(64_000);
    const unknown = await fetch(`${server.apiUrl}/api/mcp/qa-review`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "I".repeat(100_000), method: "unknown/method" }),
    });
    const unknownWire = await unknown.text();
    expect(JSON.parse(unknownWire)).toMatchObject({ id: null, error: { code: -32601 } });
    expect(Buffer.byteLength(unknownWire, "utf8")).toBeLessThanOrEqual(64_000);
  });

  it("recovers a recorded decision when its oversized response is withheld", async () => {
    const { stageId, tool, rows } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const summary = "Evidence was checked before the response failed.";
    const original = qaReviewTools.callQaReviewTool;
    const executor = vi.spyOn(qaReviewTools, "callQaReviewTool").mockImplementation(async (input) => ({
      ...await original(input), responsePadding: "P".repeat(35_000),
    }));
    let submitted!: Awaited<ReturnType<typeof tool>>;
    try {
      submitted = await tool("submit_review_decision", {
        decision: "approve", summary, expectedStageId: stageId,
        expectedStatusVersion: issue.statusVersion, expectedRevision: issue.revision,
        expectedLastDecisionId: issue.reviewStage.lastDecisionId,
      });
    } finally {
      executor.mockRestore();
    }
    expect(submitted.body.result.isError).toBe(true);
    expect(submitted.body.result.content[0].text).toContain("read_assigned_review_receipt");
    expect(submitted.body.result.content[0].text).not.toMatch(/retry/i);
    expect(submitted.wireBytes).toBeLessThanOrEqual(64_000);
    expect(await rows()).toHaveLength(1);
    const receipt = (await tool("read_assigned_review_receipt", {
      expectedStageId: stageId, decision: "approve", summary,
    })).body.result.structuredContent;
    expect(receipt).toMatchObject({ recorded: true, decisionOutcome: "approved" });
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
    expect((await tool("submit_review_decision", args)).body.result.isError).toBe(true);
    expect(await rows()).toHaveLength(1);
  });

  it("recovers only this run's formal receipt after a verdict response is lost", async () => {
    const { fixture, stageId, tool } = await reviewFixture();
    const issue = (await tool("read_assigned_issue")).body.result.structuredContent;
    const summary = "QA checked the assigned evidence.";
    const submitted = await tool("submit_review_decision", {
      decision: "approve", summary, expectedStageId: stageId,
      expectedStatusVersion: issue.statusVersion, expectedRevision: issue.revision,
      expectedLastDecisionId: null,
    });
    expect(submitted.body.result.isError).not.toBe(true);
    // Model the caller losing the successful PATCH response and reconnecting.
    const receipt = (await tool("read_assigned_review_receipt", {
      expectedStageId: stageId, decision: "approve", summary,
    })).body.result.structuredContent;
    expect(receipt).toMatchObject({
      recorded: true, issueId: fixture.issueId, stageId,
      decisionOutcome: "approved", decisionId: expect.any(String),
    });
    expect((await tool("read_assigned_review_receipt", {
      expectedStageId: stageId, decision: "approve", summary: "Different verdict text",
    })).body.result.structuredContent).toMatchObject({ recorded: false });
    const anotherRunId = randomUUID();
    await server.db.insert(heartbeatRuns).values({
      id: anotherRunId, companyId: fixture.companyId, agentId: fixture.agentId,
      status: "running", nativeIssueId: fixture.issueId,
      invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId: fixture.issueId },
    });
    const anotherToken = createLocalAgentJwt(fixture.agentId, fixture.companyId, "paperclip_runner", anotherRunId)!;
    const anotherRunReceipt = await fetch(`${server.apiUrl}/api/mcp/qa-review`, {
      method: "POST", headers: { Authorization: `Bearer ${anotherToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: {
        name: "read_assigned_review_receipt", arguments: { expectedStageId: stageId, decision: "approve", summary },
      } }),
    });
    expect(anotherRunReceipt.status).toBe(403);
    expect((await tool("read_assigned_issue")).body.result.isError).toBe(true);
    expect((await tool("submit_review_decision", {
      decision: "approve", summary, expectedStageId: stageId,
      expectedStatusVersion: issue.statusVersion, expectedRevision: issue.revision,
      expectedLastDecisionId: null,
    })).body.result.isError).toBe(true);
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

  it("recovers a request-changes receipt after assignment returns to another agent", async () => {
    const { fixture, stageId, tool } = await reviewFixture(true);
    const [lockedBefore] = await server.db.select({ executionRunId: issues.executionRunId })
      .from(issues).where(eq(issues.id, fixture.issueId));
    expect(lockedBefore!.executionRunId).toBe(fixture.runId);
    const [implementer] = await server.db.insert(agents).values({
      companyId: fixture.companyId, name: "Implementer", adapterType: "paperclip_runner", status: "active",
    }).returning();
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
    const [qaRun] = await server.db.select({ status: heartbeatRuns.status })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(qaRun!.status).toBe("running");
    // The QA subprocess is still running so the implementer wake is durable
    // and deferred until its execution lease settles.
    await expect.poll(() => server.db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, implementer!.id)), {
      timeout: 10_000,
    }).toEqual([expect.objectContaining({ status: "deferred_issue_execution" })]);
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
    const [implementerRun] = await server.db.select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, released!.runId!));
    expect(implementerRun?.agentId).toBe(implementer!.id);
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
    expect(results.find((result) => result.body.result?.isError === true)!.body.result.content[0].text)
      .toContain("re-read the issue");
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
