import { createHash } from "node:crypto";

export const MAX_INCLUDED_DOCUMENT_BYTES = 200_000;
export const MAX_INCLUDED_DOCUMENTS = 20;
export type DocumentInclusion = {
  documentId: string; key: string; revisionId: string;
  bodyBytes: number; bodySha256: string;
};
export type InclusionSource = {
  companyId: string; issueId: string; documentId: string; key: string;
  revisionId: string; latestRevisionId: string | null; revisionNumber: number;
  body: string; latestBody: string;
};
function fail(reason: string): never { throw new Error(`paperclip_runner_document_inclusion_${reason}`); }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const keyPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const documentBodyDigest = (body: string) => ({
  bodyBytes: Buffer.byteLength(body, "utf8"),
  bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
});
function utf8(body: unknown): asserts body is string {
  if (typeof body !== "string" || Buffer.from(body, "utf8").toString("utf8") !== body) fail("invalid_utf8");
}

/** Explicit author selection, never inferred from references in prose. */
export function parseDocumentInclusions(value: unknown, targetKey: string): DocumentInclusion[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_INCLUDED_DOCUMENTS) fail("invalid_input");
  const keys = new Set<string>(), ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("invalid_input");
    const row = item as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "bodyBytes,bodySha256,documentId,key,revisionId"
      || typeof row.documentId !== "string" || !uuid.test(row.documentId)
      || typeof row.revisionId !== "string" || !uuid.test(row.revisionId)
      || typeof row.key !== "string" || !keyPattern.test(row.key)
      || typeof row.bodyBytes !== "number" || !Number.isSafeInteger(row.bodyBytes)
      || row.bodyBytes < 0 || row.bodyBytes > MAX_INCLUDED_DOCUMENT_BYTES
      || typeof row.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.bodySha256)) fail("invalid_input");
    const ref = row as DocumentInclusion;
    if (ref.key === targetKey.trim().toLowerCase()) fail("self_reference");
    if (keys.has(ref.key) || ids.has(ref.documentId)) fail("duplicate");
    keys.add(ref.key); ids.add(ref.documentId);
    return { ...ref };
  });
}

/** Byte ranges, not marker searches, identify raw sections. Each fence is longer
 * than every backtick run in that section, including attacker-supplied markers. */
export function composeIncludedDocuments(
  authorBody: string, references: DocumentInclusion[], sources: InclusionSource[],
  scope: { companyId: string; issueId: string },
) {
  utf8(authorBody);
  if (!authorBody.trim()) fail("empty_author_body");
  if (sources.length !== references.length) fail("missing_source");
  if (Buffer.byteLength(authorBody, "utf8") + references.reduce((n, r) => n + r.bodyBytes, 0) > MAX_INCLUDED_DOCUMENT_BYTES) fail("too_large");
  let body = "# Author-selected fixed source material\n\n"
    + "Selection responsibility: author. Source completeness and semantic correctness: unverified. Independent QA and adoption: unverified. Byte equality is not acceptance.\n";
  function section(label: string, raw: string) {
    const fence = "`".repeat(Array.from(raw.matchAll(/`+/g)).reduce((length, match) => Math.max(length, match[0].length + 1), 3));
    body += `\n## ${label}\n\n${fence}text\n`;
    const startByte = Buffer.byteLength(body, "utf8");
    body += raw;
    const endByte = Buffer.byteLength(body, "utf8");
    body += `\n${fence}\n`;
    return { startByte, endByte, ...documentBodyDigest(raw) };
  }
  const author = section("Author confirmation (not an independent verdict)", authorBody);
  const included = references.map((ref, i) => {
    const source = sources[i]!;
    if (source.companyId !== scope.companyId || source.issueId !== scope.issueId
      || source.documentId !== ref.documentId || source.key !== ref.key
      || source.revisionId !== ref.revisionId || source.latestRevisionId !== ref.revisionId) fail("source_mismatch");
    utf8(source.body);
    if (source.body !== source.latestBody || !Number.isSafeInteger(source.revisionNumber) || source.revisionNumber < 1) fail("source_mismatch");
    const digest = documentBodyDigest(source.body);
    if (digest.bodyBytes !== ref.bodyBytes || digest.bodySha256 !== ref.bodySha256) fail("digest_mismatch");
    const range = section(`Source ${i + 1}: ${ref.key}`, source.body);
    return { ...ref, revisionNumber: source.revisionNumber, startByte: range.startByte, endByte: range.endByte };
  });
  const manifest = { schema: "paperclip.document-inclusion/v1", companyId: scope.companyId, issueId: scope.issueId,
    encoding: "utf-8", ranges: "zero-based half-open bytes of the saved document body", author, included,
    sourceSelection: "author", completeness: "unverified", independentQA: "unverified", adoption: "unverified" };
  body += `\n## Inclusion manifest\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_INCLUDED_DOCUMENT_BYTES) fail("too_large");
  return { body, manifest, ...documentBodyDigest(body) };
}

export function assertIncludedDocumentReadback(expectedBody: string, savedBody: unknown) {
  if (typeof savedBody !== "string" || savedBody !== expectedBody) fail("saved_readback_mismatch");
}
