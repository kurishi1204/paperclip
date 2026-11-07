import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, documentRevisions, documents, heartbeatRuns, issueDocuments, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { documentService } from "../services/documents.js";
import { issueService } from "../services/issues.js";
import { SELF_TASK_DOCUMENT_CONTEXT_KEY } from "../services/self-task-document-runtime.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const support = await getEmbeddedPostgresTestSupport();
if (process.env.PAPERCLIP_REQUIRE_EMBEDDED_PG === "1" && !support.supported) {
  throw new Error(`Embedded PostgreSQL is required for document digests: ${support.reason}`);
}
(support.supported ? describe : describe.skip)("persisted document revision digest HTTP", () => {
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
  async function save(issueId: string, key: string, body: string, baseRevisionId?: string) {
    const service = documentService(server.db);
    await service.upsertIssueDocument({ issueId, key, body, format: "markdown", baseRevisionId });
    const document = await service.getIssueDocumentByKey(issueId, key);
    if (!document?.latestRevisionId) throw new Error("Synthetic document was not saved");
    return document;
  }
  function url(issueId: string, key: string, revisionId: string) {
    return `${server.apiUrl}/api/issues/${issueId}/documents/${key}/revisions/${revisionId}/digest`;
  }
  it("computes exact persisted UTF-8 bytes including Unicode, CRLF and a misleading author footer", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const body = "  保存本文👩‍💻・e\u0301\r\n末尾は維持\n作者申告: bytes=0 sha256=0000\n";
    const document = await save(f.issueId, "saved-report", body);
    const response = await fetch(url(f.issueId, "saved-report", document.latestRevisionId!));
    const digest = await response.json();
    expect(response.status, JSON.stringify(digest)).toBe(200);
    expect(digest).toEqual({ issueId: f.issueId, key: "saved-report", documentId: document.id,
      revisionId: document.latestRevisionId, revisionNumber: 1, algorithm: "sha256", encoding: "utf-8",
      bodyBytes: Buffer.byteLength(body, "utf8"), bodySha256: createHash("sha256").update(body, "utf8").digest("hex") });
    expect(digest).not.toHaveProperty("body");
    expect(digest).not.toHaveProperty("verdict");
    expect(await documentService(server.db).getIssueDocumentByKey(f.issueId, "saved-report")).toEqual(document);
    expect(await documentService(server.db).listIssueDocumentRevisions(f.issueId, "saved-report")).toHaveLength(1);
  });
  it("publishes the full digest response contract in OpenAPI", async () => {
    const response = await fetch(`${server.apiUrl}/api/openapi.json`);
    expect(response.status).toBe(200);
    const spec = await response.json();
    const schema = spec.paths["/api/issues/{id}/documents/{key}/revisions/{revisionId}/digest"]
      .get.responses["200"].content["application/json"].schema;
    expect(Object.keys(schema.properties).sort()).toEqual([
      "issueId", "key", "documentId", "revisionId", "revisionNumber", "algorithm", "encoding", "bodyBytes", "bodySha256",
    ].sort());
    expect(schema.required.slice().sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.properties.bodyBytes).toMatchObject({ type: "integer", minimum: 0 });
    expect(schema.properties.bodySha256.pattern).toBe("^[0-9a-f]{64}$");
  });
  it("allows an authenticated normal agent to verify its readable task", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const document = await save(f.issueId, "report", "normal agent source\n");
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId)!;
    const response = await fetch(url(f.issueId, "report", document.latestRevisionId!), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      issueId: f.issueId, documentId: document.id, revisionId: document.latestRevisionId,
      bodySha256: createHash("sha256").update("normal agent source\n").digest("hex"),
    });
  });
  it("keeps the requested old revision bound when the current body has advanced", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const old = await save(f.issueId, "report", "original\n");
    const current = await save(f.issueId, "report", "revised\n", old.latestRevisionId!);
    const response = await fetch(url(f.issueId, "report", old.latestRevisionId!));
    expect(await response.json()).toMatchObject({ documentId: old.id, revisionId: old.latestRevisionId,
      revisionNumber: 1, bodyBytes: 9, bodySha256: createHash("sha256").update("original\n").digest("hex") });
    expect((await documentService(server.db).getIssueDocumentByKey(f.issueId, "report"))!.latestRevisionId)
      .toBe(current.latestRevisionId);
  });
  it("does not use a revision from a different document key or issue", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const one = await save(f.issueId, "one", "first");
    await save(f.issueId, "two", "second");
    expect((await fetch(url(f.issueId, "two", one.latestRevisionId!))).status).toBe(404);
    const other = await issueService(server.db).create(f.companyId, { title: "Other synthetic task", assigneeAgentId: f.agentId });
    await save(other.id, "one", "another issue");
    expect((await fetch(url(other.id, "one", one.latestRevisionId!))).status).toBe(404);
  });
  it("rejects invalid and absent revisions without a calculation or a new revision", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    await save(f.issueId, "report", "unchanged");
    expect((await fetch(url(f.issueId, "report", "invalid-id"))).status).toBe(400);
    expect((await fetch(url(f.issueId, "report", randomUUID()))).status).toBe(404);
    expect(await documentService(server.db).listIssueDocumentRevisions(f.issueId, "report")).toHaveLength(1);
  });
  it("keeps foreign-company documents unreadable to an authenticated agent", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const other = await issueService(server.db).create(f.foreignCompanyId, { title: "Foreign synthetic task" });
    const document = await save(other.id, "report", "foreign source must remain unreadable");
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId)!;
    const response = await fetch(url(other.id, "report", document.latestRevisionId!), { headers: { Authorization: `Bearer ${token}` } });
    expect([403, 404]).toContain(response.status);
    expect(await response.text()).not.toContain(document.id);
  });
  it("rejects malformed company bindings on any link, document or revision", async () => {
    for (const binding of ["link", "document", "revision"] as const) {
      const f = await server.fixture({ disableWakeOnDemand: true });
      const document = await save(f.issueId, "report", "local synthetic source");
      if (binding === "link") {
        await server.db.update(issueDocuments).set({ companyId: f.foreignCompanyId })
          .where(and(eq(issueDocuments.issueId, f.issueId), eq(issueDocuments.key, "report")));
      } else if (binding === "document") {
        await server.db.update(documents).set({ companyId: f.foreignCompanyId }).where(eq(documents.id, document.id));
      } else {
        await server.db.update(documentRevisions).set({ companyId: f.foreignCompanyId })
          .where(eq(documentRevisions.id, document.latestRevisionId!));
      }
      expect((await fetch(url(f.issueId, "report", document.latestRevisionId!))).status, binding).toBe(404);
    }
  });
  it("uses the current authenticated self-task checkout for read-only digest access", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const document = await save(f.issueId, "report", "self-task read");
    const runId = randomUUID();
    await server.db.update(agents).set({ adapterType: "claude_local", adapterConfig: { selfTaskDocumentToolsOnly: true } }).where(eq(agents.id, f.agentId));
    await server.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      status: "running", runtimeMode: "legacy", contextSnapshot: { issueId: f.issueId, [SELF_TASK_DOCUMENT_CONTEXT_KEY]: true } });
    await server.db.update(issues).set({ status: "in_progress", executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, f.issueId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "claude_local", runId)!;
    const headers = { Authorization: `Bearer ${token}`, "X-Paperclip-Document-Mode": "self-task" };
    const response = await fetch(url(f.issueId, "report", document.latestRevisionId!), { headers });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ documentId: document.id, revisionId: document.latestRevisionId });
    await server.db.update(issues).set({ checkoutRunId: f.runId }).where(eq(issues.id, f.issueId));
    expect((await fetch(url(f.issueId, "report", document.latestRevisionId!), { headers })).status).toBe(403);
  });
});
