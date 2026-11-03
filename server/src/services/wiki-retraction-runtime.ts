import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { activityLog, documents, heartbeatRuns, issueDocuments, issueThreadInteractions, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { pluginDatabaseService } from "./plugin-database.js";
import { assertConfiguredLocalFolder, getStoredLocalFolders, inspectPluginLocalFolder, readPluginLocalFolderText,
  requireLocalFolderDeclaration, resolvePluginLocalFolderPath } from "./plugin-local-folders.js";
import { executeRetraction, type RetractionFence, type RetractionScope, type RetractionStore, type RetractionTarget } from "./wiki-retraction-ledger.js";
import { loadAllWikiRetractions, withWikiRetractionLock } from "./wiki-retraction-store.js";
import { resolveReviewedWikiRetraction } from "./wiki-retraction-approval.js";
import { retractionFolderGate } from "./wiki-retraction-gate.js";
import { buildRetractionGraph, assertNoUnregisteredRetractionDependants } from "./wiki-retraction-readback.js";
import { parsePublicationRegistry, publicationCanonical, publicationHash, publicationNeed, type JsonObject } from "./wiki-publication-readback.js";

export interface WikiRetractionProposal {
  schema: "paperclip.wiki-retraction-request/v1";
  pluginId: string; target: RetractionTarget; reason: string;
  publicationRegistrySHA256: string; fence: RetractionFence;
}
const WIKI_PLUGIN = "paperclipai.plugin-llm-wiki";

/** Central host fence: used by every local-folder entry, not only tool dispatch.
 * The same DB lock encloses the real file effect and the withdrawal audit commit.
 * This deliberately conservative v1 freezes writes, including new aliases/pages. */
export function wikiRetractionRuntime(db: Db, pluginId: string) {
  const registry = pluginRegistryService(db);
  async function root(companyId: string, connection: Db = db) {
    const registry = pluginRegistryService(connection);
    const plugin = await registry.getById(pluginId);
    if (!plugin || plugin.pluginKey !== WIKI_PLUGIN) throw notFound("Wiki plugin not found");
    const settings = await registry.getCompanySettings(pluginId, companyId);
    const folder = await inspectPluginLocalFolder({ folderKey: "wiki-root",
      declaration: requireLocalFolderDeclaration(plugin.manifestJson.localFolders, "wiki-root"),
      storedConfig: getStoredLocalFolders(settings?.settingsJson)["wiki-root"] ?? null });
    assertConfiguredLocalFolder(folder);
    return folder.realPath!;
  }
  async function physical(rootPath: string, relativePath: string) {
    const resolved = await resolvePluginLocalFolderPath(rootPath, relativePath, { allowMissingLeaf: true });
    // Resolve aliases before consulting the durable physical-path fence.
    return path.relative(rootPath, resolved.realPath).split(path.sep).join("/");
  }
  async function snapshot(companyId: string, scope: RetractionScope, targetPath: string, reason: string, connection: Db): Promise<WikiRetractionProposal> {
    const registry = pluginRegistryService(connection);
    const config = await registry.getConfig(pluginId, companyId);
    const pins = parsePublicationRegistry(config?.configJson?.publicationReadback, companyId);
    publicationNeed(pins.wikiId === scope.wikiId && pins.spaceSlug === scope.spaceSlug, "retraction_scope");
    const targetPin = pins.entries.find(p => p.path === targetPath);
    publicationNeed(targetPin, "retraction_target_unregistered");
    const pluginDb = pluginDatabaseService(connection); const ns = await pluginDb.getRuntimeNamespace(pluginId);
    const spaces = await pluginDb.query<{ id: string; path_prefix: string | null }>(pluginId,
      `SELECT id, path_prefix FROM ${ns}.wiki_spaces WHERE company_id = $1 AND wiki_id = $2 AND slug = $3`,
      [companyId, scope.wikiId, scope.spaceSlug]);
    publicationNeed(spaces.length === 1, "retraction_space"); const space = spaces[0]!;
    const rows = await pluginDb.query<{ path: string; source_refs: unknown; content_hash: string }>(pluginId,
      `SELECT path, source_refs, content_hash FROM ${ns}.wiki_pages WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3`,
      [companyId, scope.wikiId, space.id]);
    const rootPath = await root(companyId, connection);
    const toPhysical = (p: string) => space.path_prefix ? `${space.path_prefix}/${p}` : p;
    const page = async (p: string): Promise<JsonObject> => {
      const matches = rows.filter(r => r.path === p); publicationNeed(matches.length === 1, "retraction_page_metadata");
      const contents = await readPluginLocalFolderText(rootPath, toPhysical(p)); const pin = pins.entries.find(e => e.path === p)!;
      publicationNeed(publicationHash(contents) === pin.wikiSHA256 && matches[0]!.content_hash === pin.wikiSHA256, "retraction_page_changed");
      return { path: p, wikiId: scope.wikiId, spaceSlug: scope.spaceSlug, sourceRefs: matches[0]!.source_refs };
    };
    const graph = await buildRetractionGraph(pins, page);
    const held = new Set([targetPath]); let changed = true;
    while (changed) { changed = false; for (const [p, parents] of graph) if (!held.has(p) && parents.some(x => held.has(x))) { held.add(p); changed = true; } }
    // Existing unregistered pages cannot silently escape dependency analysis.
    // A target-linked document reference outside the registered graph requires
    // registration/review before preview; no guessed classification is accepted.
    assertNoUnregisteredRetractionDependants(pins.entries, rows, held);
    // Index/log bytes remain untouched and available only in the audit view.
    held.add("wiki/index.md"); held.add("wiki/log.md");
    const blocks: RetractionFence["blocks"] = [];
    for (const p of [...held].sort()) {
      const rel = toPhysical(p); const canonical = await physical(rootPath, rel);
      publicationNeed(canonical === rel, "retraction_alias");
      blocks.push({ path: canonical, contentHash: publicationHash(await readPluginLocalFolderText(rootPath, rel)),
        state: p === targetPath ? "retracted" : "blocked_by_retraction" });
    }
    return { schema: "paperclip.wiki-retraction-request/v1", pluginId,
      target: { ...scope, path: targetPath, contentHash: targetPin.wikiSHA256 }, reason,
      publicationRegistrySHA256: publicationHash(publicationCanonical(pins)),
      fence: { folderKey: "wiki-root", rootPath, pathPrefix: space.path_prefix ?? "", mode: "freeze-wiki", blocks,
        readable: pins.entries.filter(p => !held.has(p.path)).map(p => ({ path: toPhysical(p.path), contentHash: p.wikiSHA256 })).sort((a,b)=>a.path.localeCompare(b.path)) } };
  }
  return {
    preview: (scope: RetractionScope, targetPath: string, reason: string) =>
      withWikiRetractionLock(db, pluginId, scope.companyId, tx => snapshot(scope.companyId, scope, targetPath, reason, tx)),
    async execute(input: { companyId: string; issueId: string; documentKey: string; reviewId: string;
      operationId: string; actorId: string; runId: string | null }) {
      return withWikiRetractionLock(db, pluginId, input.companyId, async tx => {
        const allEvents = await loadAllWikiRetractions(tx, pluginId, input.companyId);
        retractionFolderGate(allEvents, input.companyId, "wiki-root");
        const recorded = allEvents.find(e => e.type === "executed" && e.retractionId === input.operationId);
        if (recorded) {
          if (recorded.actorId !== input.actorId || recorded.approval.id !== input.reviewId ||
            recorded.approval.proposal?.issueId !== input.issueId || recorded.approval.proposal?.documentKey !== input.documentKey)
            throw conflict("operationId already belongs to another withdrawal request");
          return recorded; // Authoritative receipt, even if the proposal/config later changes.
        }
        const reviews = await tx.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, input.reviewId),
          eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId))).for("update");
        const review = reviews[0] ?? null;
        const docs = await tx.select({ doc: documents }).from(issueDocuments).innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.companyId, input.companyId), eq(issueDocuments.issueId, input.issueId), eq(issueDocuments.key, input.documentKey)))
          .for("update", { of: documents });
        const doc = docs[0]?.doc ?? null;
        const currentConfig = await pluginRegistryService(tx).getConfig(pluginId, input.companyId);
        const pins = parsePublicationRegistry(currentConfig?.configJson?.publicationReadback, input.companyId);
        const runs = review?.resolvedByRunId ? await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, review.resolvedByRunId)) : [];
        const resolved = resolveReviewedWikiRetraction({ ...input, pluginId, document: doc, review, run: runs[0] ?? null, registry: pins });
        const { proposal } = resolved;
        const events = allEvents.filter(e => e.wikiId === proposal.target.wikiId && e.spaceSlug === proposal.target.spaceSlug).sort((a,b)=>a.sequence-b.sequence);
        const fresh = await snapshot(input.companyId, proposal.target, proposal.target.path, proposal.reason, tx);
        if (publicationCanonical(fresh) !== publicationCanonical(proposal)) throw conflict("Withdrawal proposal changed; review the new snapshot");
        const store: RetractionStore = { read: async () => events, transaction: async (_scope, work) => work({
          events: async () => events, append: async event => { await tx.insert(activityLog).values({ id: event.id,
            companyId: input.companyId, actorType: "user", actorId: input.actorId, action: "wiki.page.retraction",
            entityType: "wiki_retraction", entityId: pluginId, details: event as unknown as JsonObject }); },
        }) };
        return executeRetraction(store, { target: proposal.target, fence: proposal.fence, retractionId: input.operationId,
          reason: proposal.reason, actorId: input.actorId, runId: input.runId, eventId: randomUUID(), at: new Date().toISOString(),
          approval: { id: resolved.reviewId, companyId: input.companyId, target: proposal.target, reason: proposal.reason,
            reviewerId: resolved.reviewerId, reviewRunId: resolved.reviewRunId, ownerDecisionId: input.operationId,
            proposal: { issueId: input.issueId, documentKey: input.documentKey, documentId: doc!.id,
              revisionId: doc!.latestRevisionId!, bodySHA256: publicationHash(doc!.latestBody), registrySHA256: proposal.publicationRegistrySHA256 } },
          readCurrent: async () => { const fresh = await snapshot(input.companyId, proposal.target, proposal.target.path, proposal.reason, tx); return { path: fresh.target.path, contentHash: fresh.target.contentHash }; },
        });
      });
    },
    async audit(companyId: string) {
      return withWikiRetractionLock(db, pluginId, companyId, async tx => {
        const events = await loadAllWikiRetractions(tx, pluginId, companyId);
        retractionFolderGate(events, companyId, "wiki-root"); // Validate before exposing audit.
        const plugin = await pluginRegistryService(tx).getById(pluginId);
        if (!plugin || plugin.pluginKey !== WIKI_PLUGIN) throw notFound("Wiki plugin not found");
        return Promise.all(events.map(async event => ({ event, originals: await Promise.all((event.fence?.blocks ?? []).map(async block => {
          const contents = await readPluginLocalFolderText(event.fence!.rootPath, block.path);
          return { path: block.path, contents, preserved: publicationHash(contents) === block.contentHash };
        })) })));
      });
    },
  };
}
