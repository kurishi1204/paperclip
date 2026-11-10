import { createHash } from "node:crypto";

interface ReadBinding {
  readonly companyId: string;
  readonly issueId: string;
  readonly agentId: string;
  readonly runId: string;
}

interface ReadDocument {
  readonly id: string;
  readonly key: string;
  readonly body?: string;
  readonly latestRevisionId: string | null;
  readonly latestRevisionNumber: number;
}

/** Compute from the selected source body after the caller authorizes the read.
 * This is a server tool calculation, not an agent or provider attestation.
 * A null revision ID remains null; the receipt does not invent a saved version.
 */
export function documentReadReceipt(binding: ReadBinding, document: ReadDocument) {
  if (typeof document.body !== "string") throw new Error("paperclip_document_read_body_unavailable");
  const bytes = Buffer.from(document.body, "utf8");
  return {
    schema: "paperclip.document-read-receipt.v1" as const,
    computedBy: "paperclip_server_read_tool" as const,
    bodyScope: "authorized_document_before_transport_redaction" as const,
    companyId: binding.companyId,
    issueId: binding.issueId,
    agentId: binding.agentId,
    runId: binding.runId,
    key: document.key,
    documentId: document.id,
    revisionId: document.latestRevisionId,
    revisionNumber: document.latestRevisionNumber,
    algorithm: "sha256" as const,
    encoding: "utf-8" as const,
    bodyBytes: bytes.length,
    bodySha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
