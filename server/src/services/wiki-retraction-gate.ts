import path from "node:path";
import { resolvePluginLocalFolderPath } from "./plugin-local-folders.js";
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
    for (const event of relevant) {
      const match = event.fence!.blocks.find(b => b.path === path);
      const prefix = event.fence!.pathPrefix ? event.fence!.pathPrefix + "/wiki/" : "wiki/";
      if (match || (path.startsWith(prefix) && !event.fence!.readable.some(p => p.path === path))) return { state: match?.state ?? "blocked_by_retraction", path, retractionId: event.retractionId,
        retractedPath: event.path, reason: event.reason, eventHash: event.eventHash };
    }
    return null;
  }
  return {
    active: relevant.length > 0, block,
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
