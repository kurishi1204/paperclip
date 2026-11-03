import { forbidden, conflict } from "../errors.js";
import { publicationNeed, type PublicationRegistry } from "./wiki-publication-readback.js";
import type { WikiRetractionProposal } from "./wiki-retraction-runtime.js";

/** Accept only server-loaded records. This function does not grant authority;
 * the board-only route and row locks remain mandatory at its caller. */
export function resolveReviewedWikiRetraction(input: {
  companyId: string; pluginId: string; issueId: string; documentKey: string;
  document: { id: string; companyId: string; latestRevisionId: string | null; latestBody: string;
    createdByAgentId: string | null; createdByUserId: string | null; updatedByAgentId: string | null } | null;
  review: { id: string; companyId: string; issueId: string; kind: string; status: string;
    result: unknown; payload: unknown; sourceRunId: string | null; resolvedByAgentId: string | null; resolvedByRunId: string | null } | null;
  run: { id: string; companyId: string; agentId: string; status: string } | null;
  actorId: string;
  ownerDecision: { id: string; companyId: string; issueId: string; kind: string; status: string;
    effectiveResolverPolicy: string; addresseeUserId: string | null; resolvedByUserId: string | null;
    resolvedByAgentId: string | null; resolvedByRunId: string | null; payload: unknown; result: unknown } | null;
  registry: PublicationRegistry;
}) {
  const { review, document: doc } = input;
  if (!review || review.companyId !== input.companyId || review.issueId !== input.issueId ||
    review.kind !== "request_confirmation" || review.status !== "accepted" ||
    (review.result as { outcome?: string } | null)?.outcome !== "accepted" || !review.resolvedByAgentId || !review.resolvedByRunId ||
    review.resolvedByRunId === review.sourceRunId) throw forbidden("Independent same-version withdrawal review required");
  const target = (review.payload as { target?: { type?: string; issueId?: string; documentId?: string; key?: string; revisionId?: string } }).target;
  if (!doc || doc.companyId !== input.companyId || target?.type !== "issue_document" ||
    (target.issueId != null && target.issueId !== input.issueId) || target.documentId !== doc.id ||
    target.key !== input.documentKey || target.revisionId !== doc.latestRevisionId ||
    (!doc.createdByAgentId && !doc.createdByUserId) || doc.createdByAgentId === review.resolvedByAgentId || doc.updatedByAgentId === review.resolvedByAgentId)
    throw forbidden("Review must bind the current independently-authored withdrawal proposal");
  let proposal: WikiRetractionProposal;
  try { proposal = JSON.parse(doc.latestBody); } catch { throw conflict("Withdrawal proposal must be a JSON document"); }
  publicationNeed(proposal.schema === "paperclip.wiki-retraction-request/v1" && proposal.pluginId === input.pluginId &&
    proposal.target.companyId === input.companyId && typeof proposal.reason === "string" && proposal.reason.trim(), "retraction_proposal");
  const pins = input.registry;
  const pin = pins.entries.find(p => p.path === proposal.target.path);
  if (pins.companyId !== input.companyId || pins.wikiId !== proposal.target.wikiId || pins.spaceSlug !== proposal.target.spaceSlug ||
    !pin || pin.wikiSHA256 !== proposal.target.contentHash ||
    review.resolvedByAgentId !== (pin.qaAgentId ?? pins.qaAgentId) || review.resolvedByAgentId === pin.producerAgentId)
    throw forbidden("Configured independent Wiki reviewer required");
  if (input.run?.id !== review.resolvedByRunId || input.run.companyId !== input.companyId ||
    input.run.agentId !== review.resolvedByAgentId || input.run.status !== "succeeded")
    throw forbidden("Completed independent review run required");
  // A request UUID is retry identity, never evidence of human consent. Resolve
  // a separate human-only interaction from the database under the same lock.
  const owner = input.ownerDecision;
  const ownerTarget = (owner?.payload as { target?: { type?: string; issueId?: string; documentId?: string; key?: string; revisionId?: string } } | null)?.target;
  if (!owner || owner.id === review.id || owner.companyId !== input.companyId || owner.issueId !== input.issueId ||
    owner.kind !== "request_confirmation" || owner.status !== "accepted" ||
    (owner.result as { outcome?: string } | null)?.outcome !== "accepted" ||
    owner.effectiveResolverPolicy !== "human_only" || !owner.resolvedByUserId ||
    owner.addresseeUserId !== owner.resolvedByUserId || owner.resolvedByUserId !== input.actorId ||
    owner.resolvedByAgentId !== null || owner.resolvedByRunId !== null ||
    ownerTarget?.type !== "issue_document" || ownerTarget.issueId !== input.issueId ||
    ownerTarget.documentId !== doc.id || ownerTarget.key !== input.documentKey || ownerTarget.revisionId !== doc.latestRevisionId ||
    review.resolvedByAgentId === input.actorId)
    throw forbidden("Current same-version human owner decision and separate review required");
  return { proposal, reviewId: review.id, reviewerId: review.resolvedByAgentId, reviewRunId: review.resolvedByRunId,
    ownerDecisionId: owner.id };
}
