import { pluginDatabaseService } from "./plugin-database.js";
import { publicationNeed } from "./wiki-publication-readback.js";
import { retractionFolderGate } from "./wiki-retraction-gate.js";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { resolvePluginLocalFolderPath } from "./plugin-local-folders.js";
import { RetractionError, retainedRetractionFile, validateRetractionEvents } from "./wiki-retraction-ledger.js";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";
import type { RetractionEvent, RetractionScope, RetractionStore } from "./wiki-retraction-ledger.js";

/** Existing append-only activity storage is the authoritative withdrawal ledger.
 * No mutable status row, plugin-config replacement, file edit or DB migration. */
export function wikiRetractionLockKey(pluginId: string, companyId: string) {
  return JSON.stringify(["wiki-retraction/v1", pluginId, companyId]);
}
export async function withWikiRetractionLock<T>(db: Db, pluginId: string, companyId: string,
  work: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    const key = wikiRetractionLockKey(pluginId, companyId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return work(tx as unknown as Db);
  });
}
export async function loadAllWikiRetractions(db: Pick<Db, "select">, pluginId: string, companyId: string) {
  const rows = await db.select({ details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.entityType, "wiki_retraction"),
    eq(activityLog.entityId, pluginId), eq(activityLog.action, "wiki.page.retraction"),
  ));
  return rows.map(row => row.details as unknown as RetractionEvent);
}
export function wikiRetractionStore(db: Db, pluginId: string): RetractionStore {
  async function load(connection: Pick<Db, "select">, scope: RetractionScope) {
    const rows = await connection.select({ details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.companyId, scope.companyId), eq(activityLog.entityType, "wiki_retraction"),
      eq(activityLog.entityId, pluginId), eq(activityLog.action, "wiki.page.retraction"),
    ));
    const events = rows.map(row => row.details as unknown as RetractionEvent)
      .filter(event => event.wikiId === scope.wikiId && event.spaceSlug === scope.spaceSlug);
    return events.sort((a, b) => a.sequence - b.sequence);
  }
  return {
    read: scope => load(db, scope),
    transaction: (scope, work) => db.transaction(async tx => {
      // Lock is held until the audit append commits. No arbitrary SQL replay.
      const key = wikiRetractionLockKey(pluginId, scope.companyId);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      return work({
        events: () => load(tx, scope),
        append: async event => {
          await tx.insert(activityLog).values({ id: event.id, companyId: scope.companyId,
            actorType: "user", actorId: event.actorId, action: "wiki.page.retraction",
            entityType: "wiki_retraction", entityId: pluginId,
            details: event as unknown as Record<string, unknown> });
        },
      });
    }),
  };
}

/** Caller holds the company/plugin lock and has committed the event. An
 * identical complete append is read back; partial/foreign bytes never retry. */
export async function appendRetractionMaintenanceLog(event: RetractionEvent, events: RetractionEvent[]) {
  const scoped = validateRetractionEvents(event,events.filter(e=>e.wikiId===event.wikiId&&e.spaceSlug===event.spaceSlug).sort((a,b)=>a.sequence-b.sequence));
  if (!scoped.some(e=>e.id===event.id&&e.eventHash===event.eventHash)) throw new RetractionError("maintenance_log_uncommitted");
  const log = event.maintenanceLog;
  if (!log) throw new RetractionError("maintenance_log_record_missing");
  const resolved = await resolvePluginLocalFolderPath(log.rootPath, log.path, { mustExist: true });
  if (path.relative(log.rootPath, resolved.realPath).split(path.sep).join("/") !== log.path)
    throw new RetractionError("maintenance_log_alias");
  const handle = await fs.open(resolved.realPath, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const contents = await handle.readFile("utf8");
    retainedRetractionFile(scoped, log.path, log.prefixSHA256, contents);
    if (Buffer.byteLength(contents) > log.prefixBytes) return { state: "appended" as const, alreadyPresent: true };
    await handle.writeFile(log.appendText, "utf8"); await handle.sync();
  } finally { await handle.close(); }
  const contents = await fs.readFile(resolved.realPath, "utf8");
  retainedRetractionFile(scoped, log.path, log.resultingSHA256, contents);
  return { state: "appended" as const, alreadyPresent: false };
}

/** A physical fence cannot be rebased by changing the current namespace.
 * The host calls this under its advisory lock before any folder effect. */
export async function assertWikiRetractionSpaceBindings(db:Db,pluginId:string,companyId:string,events:RetractionEvent[]) {
  const active=events.filter(e=>e.type==="executed"&&e.fence);
  if(!active.length)return;
  const pluginDb=pluginDatabaseService(db),ns=await pluginDb.getRuntimeNamespace(pluginId);
  const scopes=new Map(active.map(e=>[JSON.stringify([e.wikiId,e.spaceSlug]),e]));
  for(const event of scopes.values()) {
    const rows=await pluginDb.query<{path_prefix:string|null;root_folder_key:string;status:string}>(pluginId,
      `SELECT path_prefix,root_folder_key,status FROM ${ns}.wiki_spaces WHERE company_id=$1 AND wiki_id=$2 AND slug=$3 FOR SHARE`,
      [companyId,event.wikiId,event.spaceSlug]);
    publicationNeed(rows.length===1&&rows[0]!.root_folder_key==="wiki-root"&&rows[0]!.status==="active"&&
      active.filter(e=>e.wikiId===event.wikiId&&e.spaceSlug===event.spaceSlug)
        .every(e=>(rows[0]!.path_prefix??"")===e.fence!.pathPrefix),"republication_current_space_binding");
  }
}

/** Normal operational reads/mutations use current bindings. Historical audit
 * and receipt lookup intentionally use loadAllWikiRetractions instead. */
export async function loadCurrentWikiRetractions(db:Db,pluginId:string,companyId:string) {
  const events=await loadAllWikiRetractions(db,pluginId,companyId);
  retractionFolderGate(events,companyId,"wiki-root");
  await assertWikiRetractionSpaceBindings(db,pluginId,companyId,events);
  return events;
}
