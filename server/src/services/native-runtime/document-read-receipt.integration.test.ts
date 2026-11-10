import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentService } from "../documents.js";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { PaperclipRunnerSemanticAuthority } from "./runner-semantic-authority.js";

function readCall(runId: string, callId: string): Parameters<PaperclipRunnerSemanticAuthority["dispatch"]>[0] {
  return { operationId: "read_document", callId, input: { key: "notes" },
    correlation: { runId, normalizedSessionId: "synthetic-session", turnId: callId, itemId: callId } };
}

describe("native document read receipts through real authorities", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  beforeAll(async () => { server = await startRunnerApiTestServer(); }, 60_000);
  afterAll(async () => { await server?.close(); });

  it("calculates both native read results from exact saved UTF-8 bodies and advances with the version", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const service = documentService(server.db);
    const semantic = new PaperclipRunnerSemanticAuthority(server.db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: f.runId });
    for (const body of ["  保存👩‍💻・e\u0301\r\n作者申告: bytes=0 sha256=0000\n", "", "  revised\n"]) {
      const prior = await service.getIssueDocumentByKey(f.issueId, "notes");
      await service.upsertIssueDocument({ issueId: f.issueId, key: "notes", body, format: "markdown",
        baseRevisionId: prior!.latestRevisionId });
      const current = (await service.getIssueDocumentByKey(f.issueId, "notes"))!;
      const native = await f.authority.execute({ tool: "read_document", callId: `native-${current.latestRevisionNumber}`, arguments: { key: "notes" } }) as any;
      const result = await semantic.dispatch(readCall(f.runId, `semantic-${current.latestRevisionNumber}`));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.code);
      const read = result.value as any;
      for (const output of [native, read]) {
        expect(output.document.body).toBe(body);
        expect(output.readReceipt).toEqual({ schema: "paperclip.document-read-receipt.v1",
          computedBy: "paperclip_server_read_tool", bodyScope: "authorized_document_before_transport_redaction", companyId: f.companyId, issueId: f.issueId,
          agentId: f.agentId, runId: f.runId, key: "notes", documentId: current.id,
          revisionId: current.latestRevisionId, revisionNumber: current.latestRevisionNumber,
          algorithm: "sha256", encoding: "utf-8", bodyBytes: Buffer.byteLength(body, "utf8"),
          bodySha256: createHash("sha256").update(body, "utf8").digest("hex") });
        expect(output.readReceipt).not.toHaveProperty("body");
        expect(output.readReceipt).not.toHaveProperty("verdict");
      }
      expect(await service.getIssueDocumentByKey(f.issueId, "notes")).toEqual(current);
      expect(await service.listIssueDocumentRevisions(f.issueId, "notes")).toHaveLength(current.latestRevisionNumber);
    }
  });

  it("keeps the source-body scope explicit when the semantic transport redacts a credential", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const service = documentService(server.db);
    const prior = (await service.getIssueDocumentByKey(f.issueId, "notes"))!;
    const body = "Synthetic fixture only: Bearer synthetic-document-credential\n";
    await service.upsertIssueDocument({ issueId: f.issueId, key: "notes", body, format: "markdown", baseRevisionId: prior.latestRevisionId });
    const semantic = new PaperclipRunnerSemanticAuthority(server.db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: f.runId });
    const result = await semantic.dispatch(readCall(f.runId, "redacted"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    const output = result.value as any;
    expect(output.document.body).toBe("Synthetic fixture only: [REDACTED]\n");
    expect(output.readReceipt).toMatchObject({ bodyScope: "authorized_document_before_transport_redaction",
      bodyBytes: Buffer.byteLength(body), bodySha256: createHash("sha256").update(body).digest("hex") });
    expect(output.readReceipt.bodySha256).not.toBe(createHash("sha256").update(output.document.body).digest("hex"));
    expect(JSON.stringify(output)).not.toContain("synthetic-document-credential");
  });

  it("does not return a body or receipt for another run's company or task", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const other = await server.fixture({ disableWakeOnDemand: true });
    const bad = new PaperclipRunnerSemanticAuthority(server.db, { companyId: f.companyId, issueId: other.issueId, agentId: f.agentId, runId: f.runId });
    const result = await bad.dispatch(readCall(f.runId, "foreign"));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("value.readReceipt");
    expect(JSON.stringify(result)).not.toContain("silver-wren");
  });
});
