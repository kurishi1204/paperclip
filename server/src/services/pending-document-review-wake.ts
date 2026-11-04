import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, documents, issueDocuments, issueThreadInteractions, type Db } from "@paperclipai/db";
import type { PendingDocumentReviewBinding } from "../modules/run-dispatch/domain/policy.js";
import { parseObject } from "../adapters/utils.js";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";

/** A wake label is not review authority. Load the current card and document.
 * This only admits a named independent reader; normal tool/resolution policy,
 * issue pause, execution locks and budget checks remain in force. */
export async function readCurrentPendingDocumentReviewWake(db: Db, input: {
  companyId: string; issueId: string; agentId: string;
  runId?: string; contextSnapshot: Record<string, unknown>; lock?: boolean;
}): Promise<PendingDocumentReviewBinding | null> {
  const id = typeof input.contextSnapshot.interactionId === "string" ? input.contextSnapshot.interactionId.trim() : null;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const cards = db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
  ));
  const [card] = await (input.lock ? cards.for("share") : cards);
  if (!card || card.status !== "pending" || card.kind !== "request_confirmation" ||
      card.addresseeAgentId !== input.agentId || card.addresseeUserId ||
      (input.runId && card.sourceRunId === input.runId)) return null;
  const payload = parseObject(card.payload);
  if (Object.hasOwn(payload, "toolAction") || Object.hasOwn(payload, "secretProposal") ||
      !issueThreadInteractionAttentionAgentAllowed({ agentId: input.agentId, interaction: card })) return null;
  let admitted: Record<string, unknown> | null = null;
  if (input.runId) {
    const [run] = await db.select({ wakeupRequestId: heartbeatRuns.wakeupRequestId,
      status: heartbeatRuns.status, nativeIssueId: heartbeatRuns.nativeIssueId,
      contextSnapshot: heartbeatRuns.contextSnapshot, runnerProfileJson: heartbeatRuns.runnerProfileJson,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
    if (!run?.wakeupRequestId || !["queued", "running"].includes(run.status) ||
        (run.nativeIssueId && run.nativeIssueId !== input.issueId) ||
        parseObject(run.contextSnapshot).interactionId !== card.id ||
        parseObject(run.contextSnapshot).issueId !== input.issueId) return null;
    const receipts = db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId), eq(agentWakeupRequests.runId, input.runId),
    ));
    const [wake] = await (input.lock ? receipts.for("share") : receipts);
    const request = parseObject(wake?.payload);
    const creatorMatches = wake?.requestedByActorType === "user"
      ? Boolean(card.createdByUserId && wake.requestedByActorId === card.createdByUserId)
      : wake?.requestedByActorType === "agent" && Boolean(card.createdByAgentId && wake.requestedByActorId === card.createdByAgentId);
    if (!wake || !["queued", "claimed"].includes(wake.status) || !creatorMatches ||
        wake.idempotencyKey !== `interaction-pending:${card.id}` ||
        request.issueId !== input.issueId || request.interactionId !== card.id ||
        request.interactionKind !== card.kind) return null;
    admitted = parseObject(run.runnerProfileJson);
  }
  const target = parseObject(payload.target);
  if (target.type !== "issue_document" ||
      (target.issueId != null && target.issueId !== input.issueId) ||
      typeof target.documentId !== "string" || typeof target.key !== "string" ||
      typeof target.revisionId !== "string") return null;
  const linked = db.select({ document: { id: documents.id, companyId: documents.companyId,
    latestRevisionId: documents.latestRevisionId, latestRevisionNumber: documents.latestRevisionNumber,
    createdByAgentId: documents.createdByAgentId, createdByUserId: documents.createdByUserId,
    updatedByAgentId: documents.updatedByAgentId } }).from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.companyId, input.companyId),
      eq(issueDocuments.issueId, input.issueId), eq(issueDocuments.key, target.key)));
  const [current] = await (input.lock ? linked.for("share", { of: [documents, issueDocuments] }) : linked);
  const doc = current?.document;
  if (!doc || doc.companyId !== input.companyId || doc.id !== target.documentId ||
      doc.latestRevisionId !== target.revisionId ||
      (target.revisionNumber != null && target.revisionNumber !== doc.latestRevisionNumber) ||
      !(doc.createdByAgentId || doc.createdByUserId) ||
      doc.createdByAgentId === input.agentId || doc.updatedByAgentId === input.agentId) return null;
  const binding: PendingDocumentReviewBinding = { companyId: input.companyId, issueId: input.issueId,
    agentId: input.agentId, interactionId: card.id, documentId: doc.id,
    key: target.key, revisionId: doc.latestRevisionId, revisionNumber: doc.latestRevisionNumber };
  if (admitted && Object.hasOwn(admitted, "pendingDocumentReviewInteractionId")) {
    const previous = parseObject(admitted.pendingDocumentReviewBinding);
    if (admitted.pendingDocumentReviewInteractionId !== card.id ||
        Object.entries(binding).some(([key, value]) => previous[key] !== value)) return null;
  }
  return binding;
}

export async function isCurrentPendingDocumentReviewWake(
  db: Db, input: Parameters<typeof readCurrentPendingDocumentReviewWake>[1],
): Promise<boolean> {
  return Boolean(await readCurrentPendingDocumentReviewWake(db, input));
}

/** Only the locked dispatch writer supplies these fields. Old servers used
 * a comment-specific name; retain those already-accepted runs. */
export function hasServerRecordedNonAssigneeWake(profile: unknown): boolean {
  const value = parseObject(profile);
  return value.aiConnectionNonAssigneeWake === true || value.aiConnectionNonAssigneeCommentWake === true;
}
