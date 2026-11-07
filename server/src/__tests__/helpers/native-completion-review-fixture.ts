import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  completionContracts,
  heartbeatRuns,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
  type Db,
} from "@paperclipai/db";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import {
  NATIVE_COMPLETION_BINDING_SYSTEM_ID,
  NATIVE_COMPLETION_REVIEW_TARGET_KEY,
} from "../../services/native-runtime/native-completion-document-binding.js";

/**
 * A native completion review with the provenance the status committer gives
 * it: a run, contract, result and assessment owned by the issue, an applied
 * status decision, a card created by the committer identity, and the
 * bind_reviewer effect pointing at that card. The fixture result is not
 * accepted, so it never replaces a test's saved source result. Tests that do
 * not drive the real finalizer use this instead of imitating the card through
 * the ordinary create entry, which reserves the target key.
 */
export async function createNativeCompletionReviewFixture(
  db: Db,
  issue: { id: string; companyId: string },
  input: {
    prompt: string;
    /** Agent for a new source run; required unless sourceRunId names an existing run for this issue. */
    agentId?: string;
    decisionId?: string;
    sourceRunId?: string;
    title?: string;
    resolverPolicy?: "anyone" | "human_only";
    addresseeUserId?: string | null;
    addresseeAgentId?: string | null;
    continuationPolicy?: "none" | "wake_assignee";
    acceptLabel?: string;
    rejectLabel?: string;
    allowDeclineReason?: boolean;
  },
) {
  const decisionId = input.decisionId ?? randomUUID();
  const [existingDecision] = await db.select({ id: statusDecisions.id }).from(statusDecisions)
    .where(and(eq(statusDecisions.companyId, issue.companyId), eq(statusDecisions.id, decisionId)));
  if (!existingDecision) await insertDecisionChain(db, issue, { ...input, decisionId });
  const card = await issueThreadInteractionService(db).create(
    issue,
    {
      kind: "request_confirmation",
      title: input.title,
      resolverPolicy: input.resolverPolicy ?? "anyone",
      addresseeUserId: input.addresseeUserId ?? undefined,
      addresseeAgentId: input.addresseeAgentId ?? undefined,
      continuationPolicy: input.continuationPolicy ?? "none",
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      payload: {
        version: 1,
        prompt: input.prompt,
        ...(input.acceptLabel ? { acceptLabel: input.acceptLabel } : {}),
        ...(input.rejectLabel ? { rejectLabel: input.rejectLabel } : {}),
        ...(input.allowDeclineReason !== undefined ? { allowDeclineReason: input.allowDeclineReason } : {}),
        target: { type: "custom", key: NATIVE_COMPLETION_REVIEW_TARGET_KEY, revisionId: decisionId },
      },
    } as Parameters<ReturnType<typeof issueThreadInteractionService>["create"]>[1],
    { systemId: NATIVE_COMPLETION_BINDING_SYSTEM_ID, ...(input.sourceRunId ? { runId: input.sourceRunId } : {}) },
  );
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(statusDecisionEffects)
    .where(and(eq(statusDecisionEffects.companyId, issue.companyId), eq(statusDecisionEffects.decisionId, decisionId)));
  await db.insert(statusDecisionEffects).values({
    companyId: issue.companyId,
    issueId: issue.id,
    decisionId,
    ordinal: count + 1,
    effectKind: "bind_reviewer",
    targetType: "issue_thread_interaction",
    targetId: card.id,
    idempotencyKey: `fixture:${decisionId}:${count + 1}`,
    payload: {},
    deliveryState: "delivered",
    attemptCount: 1,
    deliveredAt: new Date(),
  });
  return card;
}

async function insertDecisionChain(
  db: Db,
  issue: { id: string; companyId: string },
  input: { decisionId: string; sourceRunId?: string; agentId?: string },
) {
  const nonce = randomUUID();
  let runId = input.sourceRunId;
  let contractId: string | null = null;
  if (runId) {
    // A result belongs to its run's own completion contract.
    const [run] = await db.select({ contractId: heartbeatRuns.completionContractId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, runId)));
    contractId = run?.contractId ?? null;
    if (!contractId) throw new Error("createNativeCompletionReviewFixture needs a source run with a completion contract");
  } else {
    if (!input.agentId) throw new Error("createNativeCompletionReviewFixture needs agentId or sourceRunId");
    const [contract] = await db.insert(completionContracts).values({
      companyId: issue.companyId, issueId: issue.id,
      revision: 100_000 + Math.floor(Math.random() * 1_000_000),
      schemaVersion: "test-fixture", policyVersion: "test-fixture", risk: "low",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {}, canonicalSha256: `fixture-${nonce}`,
      createdByActorType: "system", createdByActorId: "test-fixture",
    }).returning({ id: completionContracts.id });
    contractId = contract!.id;
    [{ id: runId }] = await db.insert(heartbeatRuns).values({
      companyId: issue.companyId, agentId: input.agentId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: issue.id, completionContractId: contractId,
      contextSnapshot: { issueId: issue.id },
    }).returning({ id: heartbeatRuns.id });
  }
  const [result] = await db.insert(nativeRunResults).values({
    companyId: issue.companyId, issueId: issue.id, runId, completionContractId: contractId,
    serverFingerprint: `fixture-${nonce}`, schemaStatus: "rejected", resultJson: {},
    canonicalSha256: `fixture-${nonce}`,
  }).returning({ id: nativeRunResults.id });
  const [assessment] = await db.insert(workAssessments).values({
    companyId: issue.companyId, issueId: issue.id, runId, contractId, resultId: result!.id,
    triggerKind: "test-fixture", triggerActorCompanyId: issue.companyId,
    priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "test-fixture",
    assessmentJson: {}, inputDigest: `fixture-${nonce}`,
  }).returning({ id: workAssessments.id });
  await db.insert(statusDecisions).values({
    id: input.decisionId, companyId: issue.companyId, issueId: issue.id, runId,
    assessmentId: assessment!.id,
    decisionVersion: 100_000 + Math.floor(Math.random() * 1_000_000),
    policyVersion: "test-fixture", fromStatus: "in_progress", toStatus: "in_review",
    reasonCode: "actionable_attention_pending",
    decisionJson: { effects: [{ kind: "bind_reviewer" }] },
    decisionDigest: `fixture-${nonce}`, applicationState: "applied",
  });
}
