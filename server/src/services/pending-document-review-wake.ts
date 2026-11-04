import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, documents, issueDocuments, issueThreadInteractions, type Db } from "@paperclipai/db";
import type { PendingDocumentReviewBinding, PendingDocumentReviewOrigin } from "../modules/run-dispatch/index.js";
import { parseObject } from "../adapters/utils.js";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";

/** A wake label is not review authority. Load the current card and document.
 * This only admits a named independent reader; normal tool/resolution policy,
 * issue pause, execution locks and budget checks remain in force. */
export async function readCurrentPendingDocumentReviewWake(db: Db, input: {
  companyId: string; issueId: string; agentId: string;
  runId?: string; contextSnapshot: Record<string, unknown>; lock?: boolean;
  /** Only the exact resolving run may finish after its own verdict. */
  allowResolvedByRunId?: string;
}): Promise<{ binding: PendingDocumentReviewBinding; origin: PendingDocumentReviewOrigin | null; interaction: typeof issueThreadInteractions.$inferSelect } | null> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const id = typeof input.contextSnapshot.interactionId === "string" ? input.contextSnapshot.interactionId.trim() : null;
  if (!id || !uuid.test(id)) return null;
  const cards = db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
  ));
  const [card] = await (input.lock ? cards.for("share") : cards);
  const resolvedByThisRun = Boolean(input.runId && input.allowResolvedByRunId === input.runId &&
    card && ["accepted", "rejected"].includes(card.status) &&
    card.resolvedByRunId === input.runId && card.resolvedByAgentId === input.agentId);
  if (!card || (card.status !== "pending" && !resolvedByThisRun) || card.kind !== "request_confirmation" ||
      card.addresseeAgentId !== input.agentId || card.addresseeUserId ||
      (input.runId && card.sourceRunId === input.runId)) return null;
  const payload = parseObject(card.payload);
  if (Object.hasOwn(payload, "toolAction") || Object.hasOwn(payload, "secretProposal") ||
      !issueThreadInteractionAttentionAgentAllowed({ agentId: input.agentId, interaction: card })) return null;
  const profiles: Record<string, unknown>[] = [];
  let origin: PendingDocumentReviewOrigin | null = null;
  if (input.runId) {
    const readRun = async (id: string) => db.select({ id: heartbeatRuns.id,
      wakeupRequestId: heartbeatRuns.wakeupRequestId, retryOfRunId: heartbeatRuns.retryOfRunId,
      status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt, resultJson: heartbeatRuns.resultJson,
      nativeIssueId: heartbeatRuns.nativeIssueId, contextSnapshot: heartbeatRuns.contextSnapshot,
      runnerProfileJson: heartbeatRuns.runnerProfileJson,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, id),
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)))
      .then(rows => rows[0]);
    const readReceipt = async (id: string, runId: string) => {
      const rows = db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, id),
        eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.runId, runId)));
      return (input.lock ? rows.for("share") : rows).then(rows => rows[0]);
    };
    const run = await readRun(input.runId);
    if (!run?.wakeupRequestId || !["queued", "running", "scheduled_retry"].includes(run.status) ||
        (run.nativeIssueId && run.nativeIssueId !== input.issueId) ||
        parseObject(run.contextSnapshot).interactionId !== card.id ||
        parseObject(run.contextSnapshot).issueId !== input.issueId) return null;
    const wake = await readReceipt(run.wakeupRequestId, run.id);
    if (!wake || !["queued", "claimed"].includes(wake.status)) return null;
    const request = parseObject(wake.payload), profile = parseObject(parseObject(run.runnerProfileJson).pendingDocumentReviewAdmission);
    let sourceRun = run, sourceWake = wake;
    if (run.retryOfRunId) {
      // Resource deferral creates a new system receipt. Its authority is the
      // saved original request, not another list of accepted retry labels.
      const saved = parseObject(profile.origin);
      if (typeof saved.runId !== "string" || typeof saved.wakeupRequestId !== "string" ||
          !uuid.test(saved.runId) || !uuid.test(saved.wakeupRequestId) ||
          saved.runId === run.id || run.retryOfRunId === run.id ||
          wake.requestedByActorType !== "system" || request.issueId !== input.issueId ||
          request.retryOfRunId !== run.retryOfRunId) return null;
      const parent = await readRun(run.retryOfRunId), source = await readRun(saved.runId);
      if (!parent?.finishedAt || !["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(parent.status) ||
          parseObject(parent.resultJson?.executionRecovery).providerWorkStarted !== false ||
          parseObject(parent.contextSnapshot).issueId !== input.issueId ||
          parseObject(parent.contextSnapshot).interactionId !== card.id ||
          !source || source.retryOfRunId || source.wakeupRequestId !== saved.wakeupRequestId ||
          parseObject(source.contextSnapshot).issueId !== input.issueId ||
          parseObject(source.contextSnapshot).interactionId !== card.id) return null;
      const receipt = await readReceipt(saved.wakeupRequestId, source.id);
      if (!receipt) return null;
      sourceRun = source; sourceWake = receipt;
      profiles.push(profile, parseObject(parseObject(parent.runnerProfileJson).pendingDocumentReviewAdmission), parseObject(parseObject(source.runnerProfileJson).pendingDocumentReviewAdmission));
    } else if (hasPendingDocumentReviewAdmission(run.runnerProfileJson)) {
      profiles.push(profile);
    }
    const sourceRequest = parseObject(sourceWake.payload);
    const creatorMatches = sourceWake.requestedByActorType === "user"
      ? Boolean(card.createdByUserId && sourceWake.requestedByActorId === card.createdByUserId)
      : sourceWake.requestedByActorType === "agent" && Boolean(card.createdByAgentId && sourceWake.requestedByActorId === card.createdByAgentId);
    if (!creatorMatches || sourceWake.idempotencyKey !== `interaction-pending:${card.id}` ||
        sourceRequest.issueId !== input.issueId || sourceRequest.interactionId !== card.id ||
        sourceRequest.interactionKind !== card.kind) return null;
    origin = { runId: sourceRun.id, wakeupRequestId: sourceWake.id };
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
  for (const profile of profiles) {
    const previous = parseObject(profile.binding), previousOrigin = parseObject(profile.origin);
    if (profile.interactionId !== card.id || !origin ||
        Object.entries(binding).some(([key, value]) => previous[key] !== value) ||
        previousOrigin.runId !== origin.runId || previousOrigin.wakeupRequestId !== origin.wakeupRequestId) return null;
  }
  return { binding, origin, interaction: card };
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
  return parseObject(value.pendingDocumentReviewAdmission).nonAssignee === true ||
    value.aiConnectionNonAssigneeWake === true || value.aiConnectionNonAssigneeCommentWake === true;
}

/** One envelope crosses profile serialization boundaries. Preserve malformed
 * evidence too, so the admission reader can reject it instead of forgetting it. */
export function hasPendingDocumentReviewAdmission(profile: unknown): boolean {
  return Object.hasOwn(parseObject(profile), "pendingDocumentReviewAdmission");
}

export function pendingDocumentReviewProfileFields(profile: unknown): Record<string, unknown> {
  const value = parseObject(profile);
  return hasPendingDocumentReviewAdmission(value)
    ? { pendingDocumentReviewAdmission: value.pendingDocumentReviewAdmission } : {};
}

/** Retries carry authority only; they never copy adapter preparation state. */
export function pendingDocumentReviewRetryProfile(profile: unknown): Record<string, unknown> | null {
  const value = parseObject(profile);
  if (!hasPendingDocumentReviewAdmission(value)) return {};
  const admission = parseObject(value.pendingDocumentReviewAdmission);
  const origin = parseObject(admission.origin), binding = parseObject(admission.binding);
  if (typeof admission.interactionId !== "string" || typeof origin.runId !== "string" ||
      typeof origin.wakeupRequestId !== "string" || binding.interactionId !== admission.interactionId) return null;
  return pendingDocumentReviewProfileFields(value);
}
