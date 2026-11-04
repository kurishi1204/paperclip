import type { RetractionEvent, RetractionBlock, RetractionFence } from "./wiki-retraction-ledger.js";
import { retractionBlock } from "./wiki-retraction-ledger.js";
import { publicationCanonical, publicationHash, publicationNeed,
  type JsonObject, type PublicationRegistry } from "./wiki-publication-readback.js";

/** Derive downstream holds from pinned, current references, including indirect
 * dependencies. No title matching, path-name inference or guessed citations. */
export async function buildRetractionGraph(registry: PublicationRegistry, page: (path: string) => Promise<JsonObject>) {
  const graph = new Map<string, string[]>();
  for (const pin of registry.entries) {
    const current = await page(pin.path);
    publicationNeed(current.path === pin.path && current.wikiId === registry.wikiId &&
      current.spaceSlug === registry.spaceSlug && Array.isArray(current.sourceRefs) &&
      publicationHash(publicationCanonical(current.sourceRefs)) === pin.sourceRefsSHA256, "retraction_references_changed");
    const parents: string[] = [];
    for (const raw of current.sourceRefs as unknown[]) {
      publicationNeed(raw && typeof raw === "object" && !Array.isArray(raw), "retraction_reference_shape");
      const ref = raw as JsonObject;
      publicationNeed(ref.kind === "document", "retraction_reference_kind");
      const matches = registry.entries.filter(p =>
        ["issueId", "documentId", "documentKey", "revisionId"].every(k => p[k as keyof typeof p] === ref[k]));
      publicationNeed(matches.length === 1, "retraction_unregistered_dependency");
      if (matches[0]!.path !== pin.path) parents.push(matches[0]!.path);
    }
    graph.set(pin.path, parents);
  }
  return graph;
}

export function filterRetractedWikiResults<T extends { content?: unknown; data?: unknown }>(
  tool: string, registry: PublicationRegistry, result: T,
  dependencies: Map<string, string[]>, events: RetractionEvent[],
): T {
  const data = result.data as JsonObject | undefined;
  publicationNeed(data && data.companyId === registry.companyId && typeof data.wikiId === "string" &&
    typeof data.spaceSlug === "string", "retraction_tool_scope");
  if (data.wikiId !== registry.wikiId || data.spaceSlug !== registry.spaceSlug) return result;
  const field = tool === "wiki_search" ? "results" : tool === "wiki_list_pages" ? "pages" : tool === "wiki_list_backlinks" ? "backlinks" : null;
  publicationNeed(field, "retraction_list_tool");
  publicationNeed(Array.isArray(data[field]), "retraction_list_shape");
  const hidden: RetractionBlock[] = [];
  const rows = (data[field] as unknown[]).filter(value => {
    publicationNeed(value && typeof value === "object" && typeof (value as JsonObject).path === "string", "retraction_list_path");
    const block = retractionBlock((value as JsonObject).path as string, dependencies, events);
    if (block) hidden.push(block);
    return !block;
  }) as JsonObject[];
  // Re-render from retained rows. Reusing the old content would leak withdrawn
  // titles/snippets even though the machine-readable array had been filtered.
  const content = rows.map(row => `${row.kind ? String(row.kind) + ": " : ""}${row.path}${row.title ? " - " + row.title : ""}`).join("\n") || "No active wiki matches found.";
  return { ...result, content, data: { ...data, [field]: rows,
    retractionReadback: { state: "checked", hiddenCount: hidden.length, tombstones: hidden } } };
}

/** Unregistered pages require follow-up only when they cite the affected
 * document versions. An unrelated registered source must not block withdrawal. */
export function assertNoUnregisteredRetractionDependants(
  pins: Array<Pick<PublicationRegistry["entries"][number], "path" | "issueId" | "documentId" | "documentKey" | "revisionId">>,
  rows: Array<{ path: string; source_refs: unknown }>, held: ReadonlySet<string>,
) {
  const docKeys = new Set(pins.filter(pin => held.has(pin.path))
    .map(pin => JSON.stringify([pin.issueId, pin.documentId, pin.documentKey, pin.revisionId])));
  for (const row of rows.filter(row => !pins.some(pin => pin.path === row.path))) {
    publicationNeed(Array.isArray(row.source_refs), "retraction_reference_shape");
    for (const ref of row.source_refs as JsonObject[]) if (ref.kind === "document") {
      const key = JSON.stringify([ref.issueId, ref.documentId, ref.documentKey, ref.revisionId]);
      publicationNeed(!docKeys.has(key), "retraction_unregistered_dependant");
    }
  }
}


/** Retain existing bytes for inspection, never as verified unrelated sources.
 * Arbitrary legacy references stay unverified. All selected pages become
 * citation holds; no guessed reference classification can grant citation use. */
export async function preserveExistingRetractionPages(
  pins: PublicationRegistry["entries"],
  rows: Array<{path:string;source_refs:unknown;content_hash:string}>,
  held: ReadonlySet<string>, preservePaths: string[],
  read: (path:string) => Promise<{path:string;contents:string}>,
  priorRead: {assertRead(path:string,contents?:string):void},
): Promise<NonNullable<RetractionFence["preservedPages"]>> {
  publicationNeed(Array.isArray(preservePaths) && new Set(preservePaths).size === preservePaths.length,
    "retraction_preserve_paths");
  const preserved: NonNullable<RetractionFence["preservedPages"]> = [];
  for (const p of [...preservePaths].sort()) {
    publicationNeed(typeof p === "string" && p.startsWith("wiki/") && !held.has(p) &&
      !pins.some(pin => pin.path === p), "retraction_preserve_path");
    const matches = rows.filter(row => row.path === p);
    publicationNeed(matches.length === 1 && Array.isArray(matches[0]!.source_refs), "retraction_preserve_metadata");
    const current = await read(p), hash = publicationHash(current.contents);
    priorRead.assertRead(current.path,current.contents);
    publicationNeed(matches[0]!.content_hash === hash, "retraction_preserve_content_changed");
    preserved.push({path:current.path,contentHash:hash,
      sourceRefsSHA256:publicationHash(publicationCanonical(matches[0]!.source_refs))});
  }
  return preserved;
}
