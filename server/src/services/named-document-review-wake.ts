import { and, eq } from "drizzle-orm";
import { WAKEUP_REQUEST_STATUSES } from "@paperclipai/shared";
import { agentWakeupRequests, issueThreadInteractions, type Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { isCurrentPendingDocumentReviewWake } from "./pending-document-review-wake.js";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";

type Enqueue = (agentId: string, options: {
  source: "automation"; triggerDetail: "system"; reason: "interaction_pending";
  payload: Record<string, unknown>; idempotencyKey: string;
  requestedByActorType: "agent"; requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

/** Run only after the outer card/semantic-receipt transaction commits.
 * The existing scheduler serializes receipt creation under its issue lock.
 * Never hold another database transaction across that scheduler callback. */
export async function ensureNamedDocumentReviewWake(db: Db, binding: {
  companyId: string; issueId: string; creatorAgentId: string; interactionId: string;
}, enqueue: Enqueue) {
    const [card] = await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, binding.interactionId),
      eq(issueThreadInteractions.companyId, binding.companyId),
      eq(issueThreadInteractions.issueId, binding.issueId),
      eq(issueThreadInteractions.createdByAgentId, binding.creatorAgentId),
    ));
    const target = parseObject(parseObject(card?.payload).target);
    if (!card || card.kind !== "request_confirmation" || !card.addresseeAgentId
      || target.type !== "issue_document" || target.key === "plan") {
      throw new Error("paperclip_runner_document_review_wake_binding_changed");
    }
    if (card.status !== "pending") return;
    if (!issueThreadInteractionAttentionAgentAllowed({ agentId: card.addresseeAgentId, interaction: card })) {
      throw new Error("paperclip_runner_document_review_wake_not_authorized");
    }
    const key = `interaction-pending:${card.id}`;
    const receipt = () => db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, binding.companyId),
      eq(agentWakeupRequests.idempotencyKey, key),
    )).then(rows => {
      if (rows.length > 1) throw new Error("paperclip_runner_document_review_duplicate_wake");
      return rows[0];
    });
    let wake = await receipt();
    if (!wake) {
      if (!await isCurrentPendingDocumentReviewWake(db, {
        companyId: binding.companyId, issueId: binding.issueId,
        agentId: card.addresseeAgentId, contextSnapshot: { interactionId: card.id },
      })) throw new Error("paperclip_runner_document_review_wake_target_changed");
      await enqueue(card.addresseeAgentId, {
        source: "automation", triggerDetail: "system", reason: "interaction_pending",
        payload: { issueId: card.issueId, interactionId: card.id, interactionKind: card.kind,
          sourceCommentId: card.sourceCommentId ?? null, sourceRunId: card.sourceRunId ?? null, mutation: "interaction" },
        idempotencyKey: key, requestedByActorType: "agent", requestedByActorId: binding.creatorAgentId,
        contextSnapshot: { issueId: card.issueId, taskId: card.issueId, interactionId: card.id,
          interactionKind: card.kind, sourceCommentId: card.sourceCommentId ?? null,
          sourceRunId: card.sourceRunId ?? null, wakeReason: "interaction_pending", source: "issue.interaction.created" },
      });
      wake = await receipt();
    }
    if (!wake || wake.agentId !== card.addresseeAgentId
      || wake.requestedByActorType !== "agent" || wake.requestedByActorId !== binding.creatorAgentId
      || wake.payload?.issueId !== card.issueId || wake.payload?.interactionId !== card.id
      || wake.payload?.interactionKind !== card.kind
      || !WAKEUP_REQUEST_STATUSES.some(status => status === wake.status)
      || ["failed", "cancelled", "skipped"].includes(wake.status)) {
      throw new Error("paperclip_runner_document_review_wake_unreceived");
    }
}
