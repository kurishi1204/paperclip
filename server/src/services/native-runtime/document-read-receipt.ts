import { inspectPaperclipSemanticValue } from "../../vendor/paperclip-runner/index.js";
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

/** Optional bounded text delivery. Full source and returned chunk have distinct receipts.
 * No base64 escape: normal transport secret redaction remains in force. */
export function documentReadResult<T extends ReadDocument>(binding: ReadBinding, document: T, rawRange?: unknown) {
  const readReceipt = documentReadReceipt(binding, document);
  if (rawRange === undefined) return { document, readReceipt };
  if (!rawRange || typeof rawRange !== "object" || Array.isArray(rawRange)) throw new Error("invalid_document_read_range");
  const range = rawRange as Record<string, unknown>;
  if (Object.keys(range).sort().join(",") !== "maxBytes,offsetBytes,revisionId" ||
      typeof range.revisionId !== "string" || range.revisionId !== document.latestRevisionId ||
      !Number.isSafeInteger(range.offsetBytes) || !Number.isSafeInteger(range.maxBytes) ||
      Number(range.offsetBytes) < 0 || Number(range.maxBytes) < 4 || Number(range.maxBytes) > 16384) {
    throw new Error("invalid_document_read_range");
  }
  // Inspect the complete source before splitting: a credential may cross a chunk boundary.
  if (inspectPaperclipSemanticValue(document.body).containsProtectedData)
    throw new Error("document_read_range_protected_data");
  const bytes = Buffer.from(document.body!, "utf8"), offset = Number(range.offsetBytes);
  if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80))
    throw new Error("invalid_document_read_utf8_offset");
  let end = Math.min(offset + Number(range.maxBytes), bytes.length);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  const chunk = bytes.subarray(offset, end);
  return { document: { ...document, body: chunk.toString("utf8") }, readReceipt,
    range: { offsetBytes: offset, returnedBytes: chunk.length, totalBytes: bytes.length,
      nextOffsetBytes: end < bytes.length ? end : null, complete: end === bytes.length,
      revisionId: document.latestRevisionId, chunkSha256: createHash("sha256").update(chunk).digest("hex"),
      bodyScope: "requested_utf8_range_before_transport_redaction" } };
}
