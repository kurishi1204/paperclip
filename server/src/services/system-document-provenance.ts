import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, documentRevisions, type Db } from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";

// Only the internal summary writer records this action. The ordinary activity
// create service rejects it, including for board callers. Existing textual
// change summaries are never used as proof that a revision was server-created.
export const SYSTEM_SUMMARY_REFRESH_ACTION = "issue.continuation_summary.refreshed";
const SYSTEM_SUMMARY_WRITER = "issue-continuation-summary";

/** Call inside the transaction holding the summary document row lock. */
export async function recordSystemSummaryRevision(db: Db, input: {
  companyId: string; issueId: string; documentId: string; revisionId: string; agentId: string; runId: string;
}) {
  const existing = await readSystemSummaryRevisions(db, input.companyId, input.issueId, [input.revisionId]);
  if (existing.has(input.revisionId)) return;
  await db.insert(activityLog).values({
    companyId: input.companyId, actorType: "system", actorId: SYSTEM_SUMMARY_WRITER,
    action: SYSTEM_SUMMARY_REFRESH_ACTION, entityType: "document", entityId: input.documentId,
    agentId: input.agentId, runId: input.runId,
    details: { issueId: input.issueId, key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY, revisionId: input.revisionId },
  });
}

export async function readSystemSummaryRevisions(
  db: Db, companyId: string, issueId: string, revisionIds: string[],
): Promise<Set<string>> {
  if (revisionIds.length === 0) return new Set();
  const rows = await db.select({ id: documentRevisions.id }).from(documentRevisions)
    .innerJoin(activityLog, and(
      eq(activityLog.companyId, documentRevisions.companyId),
      sql`${activityLog.entityId} = ${documentRevisions.documentId}::text`,
      eq(activityLog.runId, documentRevisions.createdByRunId),
      sql`${activityLog.details}->>'revisionId' = ${documentRevisions.id}::text`,
    ))
    .where(and(
      eq(documentRevisions.companyId, companyId), inArray(documentRevisions.id, revisionIds),
      eq(activityLog.actorType, "system"), eq(activityLog.actorId, SYSTEM_SUMMARY_WRITER),
      eq(activityLog.action, SYSTEM_SUMMARY_REFRESH_ACTION), eq(activityLog.entityType, "document"),
      sql`${activityLog.details}->>'issueId' = ${issueId}`,
      sql`${activityLog.details}->>'key' = ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}`,
    ));
  return new Set(rows.map(row => row.id));
}
