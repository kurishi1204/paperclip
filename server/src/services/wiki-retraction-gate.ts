import path from "node:path";
import { realpath } from "node:fs/promises";
import { resolvePluginLocalFolderPath, readPluginLocalFolderText } from "./plugin-local-folders.js";
import { publicationHash } from "./wiki-publication-readback.js";
import type { RetractionEvent, RetractionBlock } from "./wiki-retraction-ledger.js";
import { RetractionError, validateRetractionEvents } from "./wiki-retraction-ledger.js";

/** The persisted physical-path fence does not depend on publication config.
 * v1 deliberately freezes writes in the affected Wiki tree. No new page or metadata
 * can revive a dependency while the terminal hold is being reviewed. */
export function retractionFolderGate(events: RetractionEvent[], companyId: string, folderKey: string) {
  const groups = new Map<string, RetractionEvent[]>();
  for (const event of events) {
    if (event.companyId !== companyId) throw new RetractionError("ledger_scope");
    const key = JSON.stringify([event.wikiId, event.spaceSlug]);
    const group = groups.get(key) ?? []; group.push(event); groups.set(key, group);
  }
  const active = [...groups.values()].flatMap(group =>
    validateRetractionEvents(group[0]!, group.sort((a, b) => a.sequence - b.sequence)).filter(e => e.type === "executed"));
  for (const event of active) if (!event.fence) throw new RetractionError("missing_runtime_fence");
  const relevant = active.filter(e => e.fence!.folderKey === folderKey);
  function block(path: string): RetractionBlock | null {
    const blocks = relevant.map(event => retractionFolderGateSingle(event, path)).filter((b): b is RetractionBlock => b !== null);
    return blocks.find(b => b.state === "retracted" || b.readPolicy !== "citation-holds") ?? blocks[0] ?? null;
  }
  function citationHolds(filePath: string) {
    return relevant.flatMap(event => {
      const match=event.fence!.blocks.find(b => b.path === filePath);
      return event.fence!.mode === "citation-holds" && match?.state === "blocked_by_retraction"
        ? [{ state: "blocked_by_retraction" as const, path: filePath, retractedPath: event.path,
          retractionId: event.retractionId, reason: event.reason, eventHash: event.eventHash,
          readPolicy: "citation-holds" as const }] : [];
    });
  }
  function assertCitationRead(filePath: string, contents?: string) {
    for (const event of relevant) {
      // Evaluate every fence. A legacy hold or direct withdrawal must not be
      // hidden by the first, citation-only fence affecting the same page.
      const single = retractionFolderGateSingle(event, filePath);
      if (single && !(event.fence!.mode === "citation-holds" && single.state === "blocked_by_retraction"))
        throw new Error("E_SOURCE_RETRACTED " + JSON.stringify(single));
      const pin = event.fence!.blocks.find(p => p.path === filePath) ?? event.fence!.readable.find(p => p.path === filePath);
      if (contents !== undefined && pin && publicationHash(contents) !== pin.contentHash)
        throw new RetractionError("readable_content_changed");
    }
  }
  return {
    active: relevant.length > 0, block, citationHolds, assertCitationRead,
    assertRoot(rootPath: string) {
      // The recorded fence uses paths relative to this exact physical root.
      // A different root needs an explicit reviewed transition, not rebasing.
      if (relevant.some(event => event.fence!.rootPath !== rootPath))
        throw new RetractionError("runtime_root_changed");
    },
    assertRead(path: string, contents?: string) {
      const held = block(path);
      if (held) throw new Error("E_SOURCE_RETRACTED " + JSON.stringify(held));
      if (contents !== undefined) for (const event of relevant) {
        const pin = event.fence!.readable.find(p => p.path === path);
        if (pin && publicationHash(contents) !== pin.contentHash) throw new RetractionError("readable_content_changed");
      }
    },
    assertWrite(path?: string) {
      if (relevant.some(e => path === undefined || path.startsWith(e.fence!.pathPrefix ? e.fence!.pathPrefix + "/wiki/" : "wiki/")))
        throw new Error("E_WIKI_RETRACTION_WRITE_HOLD: Wiki writes are held; raw capture and originals are retained");
    },
  };
}

function retractionFolderGateSingle(event: RetractionEvent, filePath: string): RetractionBlock | null {
  const match=event.fence!.blocks.find(b => b.path === filePath);
  const prefix=event.fence!.pathPrefix ? event.fence!.pathPrefix + "/wiki/" : "wiki/";
  if (!match && !(filePath.startsWith(prefix) && !event.fence!.readable.some(p => p.path === filePath))) return null;
  // Unknown pages are never treated as reviewed downstream citations.
  return { state: match?.state ?? "retracted", path: filePath, retractedPath: event.path,
    retractionId: event.retractionId, reason: event.reason, eventHash: event.eventHash,
    ...(match && event.fence!.mode === "citation-holds" ? { readPolicy: "citation-holds" as const } : {}) };
}

/** Resolve the existing parent even when a new leaf does not exist.
 * allowMissingLeaf would preserve a symlinked parent as a lexical raw path. */
export const canonicalWikiRetractionPath = async (rootPath: string, relativePath: string) => {
    try {
      const resolved = await resolvePluginLocalFolderPath(rootPath, relativePath, { mustExist: true });
      return path.relative(rootPath, resolved.realPath).split(path.sep).join("/");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A new immutable raw capture can have new parent directories. Resolve
      // the nearest existing ancestor without creating anything or ignoring
      // containment/alias errors. The first resolver already validated syntax.
      const parts = relativePath.split("/");
      for (let n = parts.length - 1; n > 0; n--) {
        try {
          const ancestor = await resolvePluginLocalFolderPath(rootPath, parts.slice(0,n).join("/"), { mustExist: true });
          return path.relative(rootPath, path.join(ancestor.realPath, ...parts.slice(n))).split(path.sep).join("/");
        } catch (inner) { if ((inner as NodeJS.ErrnoException).code !== "ENOENT") throw inner; }
      }
      return relativePath;
    }
  };

/** Metadata may precede a raw file. Only normalize that expected absence after
 * root, lexical and physical withdrawal checks; other boundary failures escape. */
export async function readRetractionFolderText(rootPath: string, relativePath: string,
  gate: ReturnType<typeof retractionFolderGate>, citationAware = false): Promise<string> {
  const assertRead = citationAware ? gate.assertCitationRead : gate.assertRead;
  gate.assertRoot(rootPath); assertRead(relativePath);
  const canonical = await canonicalWikiRetractionPath(rootPath, relativePath);
  assertRead(canonical);
  let contents: string;
  try { contents = await readPluginLocalFolderText(rootPath, relativePath); }
  catch (error) {
    if (gate.active && (error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      // A missing or changed root is not a not-yet-materialized source file.
      gate.assertRoot(await realpath(rootPath));
      throw new Error("E_WIKI_SOURCE_NOT_MATERIALIZED");
    }
    throw error;
  }
  assertRead(canonical, contents); return contents;
}

export async function readRetractionFolderTextWithStatus(rootPath: string, relativePath: string,
  gate: ReturnType<typeof retractionFolderGate>) {
  const contents = await readRetractionFolderText(rootPath, relativePath, gate, true);
  const canonical = await canonicalWikiRetractionPath(rootPath, relativePath);
  return { contents, citationHolds: gate.citationHolds(canonical) };
}
