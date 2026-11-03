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
