import { and, eq } from "drizzle-orm";
import { documents, issueDocuments, issueThreadInteractions, type Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";

/** A wake label is not review authority. Load the current card and document.
 * This only admits a named independent reader; normal tool/resolution policy,
 * issue pause, execution locks and budget checks remain in force. */
export async function isCurrentPendingDocumentReviewWake(db: Db, input: {
  companyId: string; issueId: string; agentId: string;
  runId?: string; contextSnapshot: Record<string, unknown>; lock?: boolean;
}): Promise<boolean> {
  const id = typeof input.contextSnapshot.interactionId === "string" ? input.contextSnapshot.interactionId.trim() : null;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  const cards = db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
  ));
  const [card] = await (input.lock ? cards.for("share") : cards);
  if (!card || card.status !== "pending" || card.kind !== "request_confirmation" ||
      card.addresseeAgentId !== input.agentId || card.addresseeUserId ||
      (input.runId && card.sourceRunId === input.runId)) return false;
  const payload = parseObject(card.payload);
  if (Object.hasOwn(payload, "toolAction") || Object.hasOwn(payload, "secretProposal") ||
      !issueThreadInteractionAttentionAgentAllowed({ agentId: input.agentId, interaction: card })) return false;
  const target = parseObject(payload.target);
  if (target.type !== "issue_document" ||
      (target.issueId != null && target.issueId !== input.issueId) ||
      typeof target.documentId !== "string" || typeof target.key !== "string" ||
      typeof target.revisionId !== "string") return false;
  const linked = db.select({ document: { id: documents.id, companyId: documents.companyId,
    latestRevisionId: documents.latestRevisionId, latestRevisionNumber: documents.latestRevisionNumber,
    createdByAgentId: documents.createdByAgentId, createdByUserId: documents.createdByUserId,
    updatedByAgentId: documents.updatedByAgentId } }).from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.companyId, input.companyId),
      eq(issueDocuments.issueId, input.issueId), eq(issueDocuments.key, target.key)));
  const [current] = await (input.lock ? linked.for("share", { of: [documents, issueDocuments] }) : linked);
  const doc = current?.document;
  return Boolean(doc && doc.companyId === input.companyId && doc.id === target.documentId &&
    doc.latestRevisionId === target.revisionId &&
    (target.revisionNumber == null || target.revisionNumber === doc.latestRevisionNumber) &&
    (doc.createdByAgentId || doc.createdByUserId) &&
    doc.createdByAgentId !== input.agentId && doc.updatedByAgentId !== input.agentId);
}

/** Only the locked dispatch writer supplies these fields. Old servers used
 * a comment-specific name; retain those already-accepted runs. */
export function hasServerRecordedNonAssigneeWake(profile: unknown): boolean {
  const value = parseObject(profile);
  return value.aiConnectionNonAssigneeWake === true || value.aiConnectionNonAssigneeCommentWake === true;
}
