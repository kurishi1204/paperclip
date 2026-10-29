import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, documentRevisions, documents, heartbeatRuns, issueDocuments, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { documentService } from "../services/documents.js";
import { issueService } from "../services/issues.js";
import { callProjectTool } from "../services/project-tools.js";
import { SELF_TASK_DOCUMENT_CONTEXT_KEY } from "../services/self-task-document-runtime.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const support = await getEmbeddedPostgresTestSupport();
if (process.env.PAPERCLIP_REQUIRE_EMBEDDED_PG === "1" && !support.supported) {
  throw new Error(`Embedded PostgreSQL is required for issue document input: ${support.reason}`);
}

(support.supported ? describe : describe.skip)("new document-only issue input", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const oldSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer({ deploymentMode: "local_trusted" });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (oldSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldSecret;
  });

  async function fixture() {
    const f = await server.fixture({ disableWakeOnDemand: true });
    await server.db.update(agents).set({ adapterType: "claude_local",
      adapterConfig: { selfTaskDocumentToolsOnly: true },
    }).where(eq(agents.id, f.agentId));
    return f;
  }

  it("preserves a new request and reads that same input before one HTTP result save", async () => {
    const f = await fixture();
    const title = "Prepare a synthetic intake checklist";
    const description = "Keep observations separate from unverified interpretations.\nPreserve source references.";
    const response = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/issues`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description, status: "backlog", assigneeAgentId: f.agentId }),
    });
    const created = await response.json();
    expect(response.status, JSON.stringify(created)).toBe(201);
    const plan = await documentService(server.db).getIssueDocumentByKey(created.id, "plan");
    expect(plan).toMatchObject({ title: "Task request", body: `${title}\n\n${description}`, latestRevisionNumber: 1,
      createdByAgentId: created.createdByAgentId, createdByUserId: created.createdByUserId,
      sourceTrust: created.sourceTrust ?? null });
    const runId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId,
      agentId: f.agentId, status: "running", runtimeMode: "legacy",
      contextSnapshot: { issueId: created.id, [SELF_TASK_DOCUMENT_CONTEXT_KEY]: true },
    });
    await server.db.update(issues).set({ status: "in_progress", executionRunId: runId, checkoutRunId: runId })
      .where(eq(issues.id, created.id));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "claude_local", runId)!;
    const base = { apiUrl: server.apiUrl, token, companyId: f.companyId,
      issueId: created.id, agentId: f.agentId, conversation: false };
    const read = await callProjectTool({ ...base, name: "read_self_task_document", arguments: { key: "plan" } });
    expect(read).toMatchObject({ outcome: "verified", documentId: plan!.id,
      revisionId: plan!.latestRevisionId, body: `${title}\n\n${description}` });
    if (read.outcome !== "verified" || typeof read.documentId !== "string" ||
        typeof read.revisionId !== "string" || typeof read.bodySha256 !== "string") throw new Error("Input receipt missing");
    const saved = await callProjectTool({ ...base, name: "write_self_task_document", arguments: {
      key: "result", title: "Synthetic checklist", format: "markdown", body: "A source-bound synthetic result.",
      documentId: null, baseRevisionId: null,
      input: { key: "plan", documentId: read.documentId, revisionId: read.revisionId, bodySha256: read.bodySha256 },
    } });
    expect(saved).toMatchObject({ outcome: "verified", requests: { reads: 1, puts: 1, readbacks: 1 } });
    const result = await documentService(server.db).getIssueDocumentByKey(created.id, "result");
    expect(result).toMatchObject({ latestRevisionId: saved.revisionId, latestRevisionNumber: 1,
      body: "A source-bound synthetic result." });
    expect((await documentService(server.db).getIssueDocumentByKey(created.id, "plan"))!.latestRevisionId)
      .toBe(plan!.latestRevisionId);
  });

  it("keeps explicit plans and their original trust and attribution unchanged", async () => {
    const f = await fixture();
    const sourceTrust = { preset: "standard" as const, disposition: "promoted" as const,
      sourceIssueId: f.issueId, sourceRunId: f.runId, sourceAgentId: f.agentId };
    const created = await issueService(server.db).create(f.companyId, { title: "Explicit plan input",
      description: "Request text must not replace this plan.", initialPlan: "  Original explicit plan\n",
      status: "backlog", assigneeAgentId: f.agentId, createdByAgentId: f.agentId,
      createdByUserId: "synthetic-board-user", actorRunId: f.runId, sourceTrust,
    });
    const plan = await documentService(server.db).getIssueDocumentByKey(created.id, "plan");
    expect(plan).toMatchObject({ title: "Plan", body: "  Original explicit plan\n", sourceTrust,
      createdByAgentId: f.agentId, createdByUserId: "synthetic-board-user" });
    const rows = await server.db.select().from(documentRevisions).where(eq(documentRevisions.documentId, plan!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ createdByAgentId: f.agentId, createdByUserId: "synthetic-board-user",
      createdByRunId: f.runId, body: "  Original explicit plan\n" });
  });

  it("does not seed documents for ordinary, QA-only, other-adapter or unassigned issues", async () => {
    const f = await fixture();
    const profiles = [
      { adapterType: "claude_local", adapterConfig: {} },
      { adapterType: "claude_local", adapterConfig: { selfTaskDocumentToolsOnly: true, qaReviewToolsOnly: true } },
      { adapterType: "codex_local", adapterConfig: { selfTaskDocumentToolsOnly: true } },
    ];
    for (const [index, profile] of profiles.entries()) {
      await server.db.update(agents).set(profile).where(eq(agents.id, f.agentId));
      const created = await issueService(server.db).create(f.companyId, { title: `Ordinary request ${index}`,
        description: "No automatic document outside the fixed runtime.", assigneeAgentId: f.agentId });
      expect(await documentService(server.db).listIssueDocuments(created.id)).toEqual([]);
    }
    const unassigned = await issueService(server.db).create(f.companyId, { title: "Unassigned request" });
    expect(await documentService(server.db).listIssueDocuments(unassigned.id)).toEqual([]);
  });

  it("retains title-only and description-only source text without generated prose", async () => {
    const f = await fixture();
    const sourceTrust = { preset: "standard" as const, disposition: "promoted" as const,
      sourceIssueId: f.issueId, sourceRunId: f.runId, sourceAgentId: f.agentId };
    for (const request of [{ title: "  Original title only  " }, { description: "  Original description only.\n" }]) {
      const created = await issueService(server.db).create(f.companyId, { ...request, assigneeAgentId: f.agentId,
        sourceTrust, createdByAgentId: f.agentId, createdByUserId: "synthetic-board-user", actorRunId: f.runId });
      const plan = await documentService(server.db).getIssueDocumentByKey(created.id, "plan");
      expect(plan?.body).toBe("title" in request ? request.title : request.description);
      expect(plan).toMatchObject({ sourceTrust, createdByAgentId: f.agentId, createdByUserId: "synthetic-board-user" });
      const [revision] = await server.db.select().from(documentRevisions).where(eq(documentRevisions.documentId, plan!.id));
      expect(revision).toMatchObject({ createdByRunId: f.runId, createdByAgentId: f.agentId,
        createdByUserId: "synthetic-board-user", body: plan!.body });
    }
  });

  it("uses the assigned task's effective document-mode override", async () => {
    const f = await fixture();
    const disabled = await issueService(server.db).create(f.companyId, { title: "Task disables document-only runtime",
      assigneeAgentId: f.agentId, assigneeAdapterOverrides: { adapterConfig: { selfTaskDocumentToolsOnly: false } } });
    expect(await documentService(server.db).listIssueDocuments(disabled.id)).toEqual([]);
    await server.db.update(agents).set({ adapterConfig: {} }).where(eq(agents.id, f.agentId));
    const enabled = await issueService(server.db).create(f.companyId, { title: "Task enables document-only runtime",
      assigneeAgentId: f.agentId, assigneeAdapterOverrides: { adapterConfig: { selfTaskDocumentToolsOnly: true } } });
    expect((await documentService(server.db).getIssueDocumentByKey(enabled.id, "plan"))?.body).toBe(enabled.title);
  });

  it("replays a duplicate without changing its input document or adding a revision", async () => {
    const f = await fixture();
    const service = issueService(server.db);
    const request = { title: "One fixed input", description: "Original request body", assigneeAgentId: f.agentId,
      idempotencyKey: `input:${randomUUID()}`, allowDuplicate: false };
    const first = await service.create(f.companyId, request);
    const plan = await documentService(server.db).getIssueDocumentByKey(first.id, "plan");
    const replay = await service.create(f.companyId, { ...request, description: "Must not replace the original" });
    expect(replay.id).toBe(first.id);
    const titleReplay = await service.create(f.companyId, { title: request.title,
      description: "A duplicate title must not append input", assigneeAgentId: f.agentId, allowDuplicate: false });
    expect(titleReplay.id).toBe(first.id);
    expect(await documentService(server.db).getIssueDocumentByKey(first.id, "plan")).toMatchObject({
      id: plan!.id, latestRevisionId: plan!.latestRevisionId, body: "One fixed input\n\nOriginal request body" });
    const rows = await server.db.select().from(documentRevisions).where(eq(documentRevisions.documentId, plan!.id));
    expect(rows).toHaveLength(1);
    expect(createHash("sha256").update(rows[0]!.body).digest("hex"))
      .toBe(createHash("sha256").update(plan!.body!).digest("hex"));
  });

  it("rolls back the issue and seeded input together when the create transaction fails", async () => {
    const f = await fixture();
    const id = randomUUID();
    await expect(server.db.transaction(async tx => {
      await issueService(server.db).create(f.companyId, { id, title: "Rolled-back request", assigneeAgentId: f.agentId }, tx);
      expect((await documentService(tx as unknown as typeof server.db).getIssueDocumentByKey(id, "plan"))?.body)
        .toBe("Rolled-back request");
      throw new Error("synthetic create transaction abort");
    })).rejects.toThrow("synthetic create transaction abort");
    expect(await server.db.select().from(issues).where(eq(issues.id, id))).toEqual([]);
    expect(await server.db.select().from(issueDocuments).where(eq(issueDocuments.issueId, id))).toEqual([]);
    expect(await server.db.select().from(documents).where(and(eq(documents.companyId, f.companyId),
      eq(documents.latestBody, "Rolled-back request")))).toEqual([]);
  });
});
