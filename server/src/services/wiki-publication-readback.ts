import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;
export interface PublicationPin {
  path: string; issueId: string; documentId: string; documentKey: string;
  revisionId: string; producerAgentId: string; reviewId: string;
  wikiSHA256: string; documentBodySHA256: string; reviewRecordSHA256: string;
  sourceRefsSHA256: string;
}
export interface PublicationRegistry {
  schema: "colo.shared-wiki-publication-readback/v1";
  companyId: string; wikiId: string; spaceSlug: string; qaAgentId: string;
  entries: PublicationPin[];
}
export interface PublicationReaders {
  page(path: string): Promise<JsonObject>;
  document(issueId: string, key: string): Promise<JsonObject | null>;
  review(issueId: string, id: string): Promise<JsonObject | null>;
}
export function publicationNeed(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`wiki_publication_${reason}`);
}
export function publicationHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sortJson(v)]));
  }
  return value;
}
export function publicationCanonical(value: unknown): string {
  return JSON.stringify(sortJson(JSON.parse(JSON.stringify(value))), null, 2) + "\n";
}
function object(value: unknown): JsonObject {
  publicationNeed(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_record");
  return value as JsonObject;
}
export function parsePublicationRegistry(value: unknown, companyId: string): PublicationRegistry {
  const record = object(value);
  publicationNeed(record.schema === "colo.shared-wiki-publication-readback/v1" && record.companyId === companyId, "registry_scope");
  for (const field of ["wikiId", "spaceSlug", "qaAgentId"]) publicationNeed(typeof record[field] === "string" && record[field], "registry_shape");
  publicationNeed(Array.isArray(record.entries) && record.entries.length > 0, "registry_entries");
  for (const item of record.entries) {
    const pin = object(item);
    for (const field of ["path", "issueId", "documentId", "documentKey", "revisionId", "producerAgentId", "reviewId"]) publicationNeed(typeof pin[field] === "string" && pin[field], "registry_pin");
    for (const field of ["wikiSHA256", "documentBodySHA256", "reviewRecordSHA256", "sourceRefsSHA256"]) publicationNeed(typeof pin[field] === "string" && /^[0-9a-f]{64}$/.test(pin[field] as string), "registry_hash");
  }
  publicationNeed(new Set(record.entries.map((p: PublicationPin) => p.path)).size === record.entries.length, "duplicate_pin");
  return record as unknown as PublicationRegistry;
}
function reviewBasis(review: JsonObject) {
  return Object.fromEntries(["id", "companyId", "issueId", "status", "sourceRunId", "resolvedByAgentId", "resolvedByRunId", "resolvedAt", "payload", "result"].map(k => [k, review[k] ?? null]));
}
export interface PublicationCitation {
  path: string; wikiSHA256: string; documentId: string; revisionId: string;
  documentBodySHA256: string; bodyByteStart: number; bodyByteEndExclusive: number; reviewId: string;
}
export async function verifyWikiPublication(registry: PublicationRegistry, path: string, readers: PublicationReaders, seen = new Set<string>()): Promise<{ state: "verified"; citation: PublicationCitation; dependencies: PublicationCitation[] }> {
  publicationNeed(!seen.has(path), "dependency_cycle");
  const nextSeen = new Set(seen).add(path);
  const matches = registry.entries.filter(p => p.path === path);
  publicationNeed(matches.length === 1, "unregistered_page");
  const pin = matches[0]!; const page = await readers.page(path);
  publicationNeed(page.path === path && page.wikiId === registry.wikiId && page.spaceSlug === registry.spaceSlug && typeof page.contents === "string", "page_scope");
  publicationNeed(publicationHash(page.contents) === pin.wikiSHA256 && page.hash === pin.wikiSHA256, "page_changed");
  publicationNeed(Array.isArray(page.sourceRefs) && publicationHash(publicationCanonical(page.sourceRefs)) === pin.sourceRefsSHA256, "references_changed");
  const document = await readers.document(pin.issueId, pin.documentKey);
  publicationNeed(document && document.companyId === registry.companyId && document.issueId === pin.issueId && document.id === pin.documentId && document.latestRevisionId === pin.revisionId && typeof document.body === "string" && publicationHash(document.body) === pin.documentBodySHA256, "document_changed");
  const bytes = Buffer.from(page.contents); const body = Buffer.from(document.body as string); const start = bytes.indexOf(body);
  publicationNeed(body.length > 0 && start >= 0 && bytes.indexOf(body, start + 1) === -1, "body_not_unique_exact_copy");
  const review = await readers.review(pin.issueId, pin.reviewId);
  publicationNeed(review && review.id === pin.reviewId && review.companyId === registry.companyId && review.issueId === pin.issueId && review.status === "accepted" && object(review.result).outcome === "accepted", "review_not_accepted");
  publicationNeed(review.resolvedByAgentId === registry.qaAgentId && review.resolvedByAgentId !== pin.producerAgentId && review.resolvedByRunId && review.resolvedByRunId !== review.sourceRunId, "review_not_independent");
  publicationNeed(publicationHash(publicationCanonical(reviewBasis(review))) === pin.reviewRecordSHA256, "review_changed");
  const refs = page.sourceRefs.map(object); const own = refs.filter(r => r.kind === "document" && r.documentId === pin.documentId);
  publicationNeed(own.length === 1 && ["issueId", "documentId", "documentKey", "revisionId"].every(k => own[0]![k] === pin[k as keyof PublicationPin]), "own_reference_changed");
  const dependencies: PublicationCitation[] = [];
  for (const ref of refs) {
    publicationNeed(ref.kind === "document", "unregistered_source_kind");
    if (ref.documentId === pin.documentId) continue;
    const parents = registry.entries.filter(p => ["issueId", "documentId", "documentKey", "revisionId"].every(k => p[k as keyof PublicationPin] === ref[k]));
    publicationNeed(parents.length === 1, "unregistered_dependency");
    const parent = await verifyWikiPublication(registry, parents[0]!.path, readers, nextSeen); dependencies.push(parent.citation);
  }
  publicationNeed(new Set(dependencies.map(p => p.path)).size === dependencies.length, "duplicate_dependency");
  return { state: "verified", citation: { path, wikiSHA256: pin.wikiSHA256, documentId: pin.documentId, revisionId: pin.revisionId, documentBodySHA256: pin.documentBodySHA256, bodyByteStart: start, bodyByteEndExclusive: start + body.length, reviewId: pin.reviewId }, dependencies };
}

export async function applyWikiPublicationReadback<T extends { content?: unknown; data?: unknown }>(configuration: unknown, companyId: string, parameters: unknown, result: T, readers: PublicationReaders): Promise<T> {
  const registry = parsePublicationRegistry(configuration, companyId); const args = object(parameters);
  publicationNeed(args.companyId === companyId && typeof args.path === "string", "request_scope");
  publicationNeed(result.data === undefined || (result.data !== null && typeof result.data === "object" && !Array.isArray(result.data)), "tool_data_shape");
  publicationNeed(typeof result.content === "string", "tool_content_shape");
  const data = (result.data ?? {}) as JsonObject;
  if ((args.wikiId ?? "default") !== registry.wikiId || (args.spaceSlug ?? "default") !== registry.spaceSlug || !registry.entries.some(p => p.path === args.path)) {
    return { ...result, content: "[Current publication receipt not registered for this Wiki page; treat it as unverified source material.]\n\n" + result.content, data: { ...data, publicationReadback: { state: "unregistered" } } };
  }
  let root: JsonObject | undefined;
  const proof = await verifyWikiPublication(registry, args.path, { ...readers, page: async path => { const value = await readers.page(path); if (path === args.path) root = value; return value; } });
  publicationNeed(result.content === root?.contents, "tool_body_changed");
  publicationNeed(data.companyId === companyId && data.wikiId === registry.wikiId &&
    data.spaceSlug === registry.spaceSlug && data.path === args.path &&
    data.hash === proof.citation.wikiSHA256, "tool_metadata_changed");
  return { ...result, data: { ...data, publicationReadback: proof } };
}
