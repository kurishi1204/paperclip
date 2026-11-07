import { and, asc, eq, inArray } from "drizzle-orm";
import {
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issues,
  statusDecisionEffects,
  type Db,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY, type RequestConfirmationBoundDocument } from "@paperclipai/shared";
import { conflict, forbidden, unprocessable } from "../../errors.js";
import { readSystemSummaryRevisions } from "../system-document-provenance.js";

type BindingActor = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

/** The only actor that may create a native completion review or its binding. */
export const NATIVE_COMPLETION_BINDING_SYSTEM_ID = "native-status-committer";
export const NATIVE_COMPLETION_REVIEW_TARGET_KEY = "native_completion_review";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LinkedDocumentRow = {
  documentId: string;
  key: string;
  revisionId: string | null;
  revisionNumber: number;
};

/**
 * Read every submitted issue document. The issue row is the serialization
 * point for its documents: the paperclip_bump_issue_revision_from_child
 * triggers (migration 0313) lock it FOR UPDATE before any issue_documents
 * insert/update/delete or linked documents update. Holding that lock, the set
 * read here cannot gain, lose or change a document until the caller commits.
 * Callers already hold it, so this repeats the same lock without a new order.
 * Document rows are deliberately not locked: a writer holds its document row
 * before the trigger waits for the issue.
 */
async function readLinkedDocuments(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<LinkedDocumentRow[]> {
  await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .for("update");
  const rows = await db
    .select({
      documentId: documents.id,
      key: issueDocuments.key,
      revisionId: documents.latestRevisionId,
      revisionNumber: documents.latestRevisionNumber,
    })
    .from(issueDocuments)
    .innerJoin(
      documents,
      and(
        eq(documents.id, issueDocuments.documentId),
        eq(documents.companyId, input.companyId),
      ),
    )
    .where(
      and(
        eq(issueDocuments.companyId, input.companyId),
        eq(issueDocuments.issueId, input.issueId),
      ),
    )
    .orderBy(asc(issueDocuments.key), asc(documents.id));
  // Only a revision recorded by the reserved internal writer is bookkeeping.
  // Legacy/imported revisions, even with an exact forged textual marker, remain
  // in the submitted work set. The pipeline case body is always submitted work.
  const summaryRevisionIds = rows
    .filter(row => row.key === ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY && row.revisionId)
    .map(row => row.revisionId!);
  const systemSummaryRevisions = await readSystemSummaryRevisions(
    db, input.companyId, input.issueId, summaryRevisionIds,
  );
  return rows.filter((row) => !(row.key === ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY && row.revisionId &&
    systemSummaryRevisions.has(row.revisionId)));
}

/**
 * The binding recorded with a new completion review. A linked document without
 * a current revision cannot be bound; it stays visible to approval, which
 * refuses it as inconsistent instead of treating it as absent.
 */
export async function readNativeCompletionDocumentRevisions(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<RequestConfirmationBoundDocument[]> {
  return (await readLinkedDocuments(db, input)).flatMap((row) =>
    row.revisionId
      ? [{ documentId: row.documentId, key: row.key, revisionId: row.revisionId, revisionNumber: row.revisionNumber }]
      : []);
}

function readTarget(payload: unknown) {
  const target = payload && typeof payload === "object"
    ? (payload as { target?: unknown }).target
    : null;
  return target && typeof target === "object"
    ? (target as { type?: unknown; key?: unknown; revisionId?: unknown; boundDocuments?: unknown })
    : null;
}

/**
 * The native completion review card and its document binding are internal to
 * the status committer. The ordinary interaction create entry (HTTP, runner
 * tools, plugins) cannot create the reserved target key or supply a binding.
 */
export function assertNativeCompletionReviewCreateAllowed(payload: unknown, actor: { systemId?: string | null }) {
  const target = readTarget(payload);
  if (target?.type !== "custom" || actor.systemId === NATIVE_COMPLETION_BINDING_SYSTEM_ID) return;
  if (target.key === NATIVE_COMPLETION_REVIEW_TARGET_KEY) {
    throw unprocessable("Native completion reviews are created by the server from a completion decision.", {
      code: "native_completion_review_reserved",
    });
  }
  if (target.boundDocuments !== undefined) {
    throw unprocessable("boundDocuments is recorded by the server for completion reviews and cannot be supplied.", {
      code: "native_completion_review_binding_server_owned",
    });
  }
}

type ReviewCard = { id: string; payload: unknown; createdByAgentId: string | null; createdByUserId: string | null };

/**
 * A native completion review is genuine only when the status committer
 * materialized it for the decision it names: a system-created card with a
 * bind_reviewer status-decision effect pointing at it. A card that merely
 * carries the same target key has no authority.
 */
async function hasNativeCompletionReviewProvenance(
  db: Db,
  input: { companyId: string; issueId: string; interaction: ReviewCard },
): Promise<boolean> {
  const target = readTarget(input.interaction.payload);
  if (typeof target?.revisionId !== "string" || !UUID.test(target.revisionId) ||
      input.interaction.createdByAgentId || input.interaction.createdByUserId) return false;
  const [effect] = await db
    .select({ id: statusDecisionEffects.id })
    .from(statusDecisionEffects)
    .where(and(
      eq(statusDecisionEffects.companyId, input.companyId),
      eq(statusDecisionEffects.issueId, input.issueId),
      eq(statusDecisionEffects.decisionId, target.revisionId),
      eq(statusDecisionEffects.effectKind, "bind_reviewer"),
      eq(statusDecisionEffects.targetType, "issue_thread_interaction"),
      eq(statusDecisionEffects.targetId, input.interaction.id),
    ))
    .limit(1);
  return Boolean(effect);
}

/**
 * Acceptance of a native completion review approves the exact document
 * revisions recorded at submission. A later revision, an added or removed
 * document, or an approving agent that wrote any bound revision cannot reuse it.
 * Rejection stays available so the reviewer can send stale work back.
 */
export async function assertNativeCompletionDocumentBindingCurrent(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    interaction: ReviewCard;
    actor: BindingActor;
  },
) {
  if (!await hasNativeCompletionReviewProvenance(db, input)) {
    throw conflict(
      "This completion review was not created from a completion decision and cannot complete the task.",
      { code: "native_completion_review_provenance_missing" },
    );
  }
  const linked = await readLinkedDocuments(db, input);
  const inconsistent = linked.filter((row) => !row.revisionId);
  if (inconsistent.length > 0) {
    throw conflict(
      "A task document has no current revision, so the submitted documents cannot be verified. Request changes so the worker resubmits.",
      { code: "native_completion_review_documents_inconsistent",
        documents: inconsistent.map((row) => ({ documentId: row.documentId, key: row.key })) },
    );
  }
  const current = linked as RequestConfirmationBoundDocument[];
  const recorded = readTarget(input.interaction.payload)?.boundDocuments;
  const bound = Array.isArray(recorded) ? (recorded as RequestConfirmationBoundDocument[]) : null;
  if (!bound) {
    // A genuine card recorded before revision binding existed carries no
    // document set. Only a task that still has no documents can be approved
    // from it; one with documents goes back for resubmission.
    if (current.length === 0) return;
    throw conflict(
      "This completion review did not record its document revisions. Request changes so the worker resubmits the current documents.",
      { code: "native_completion_review_documents_unbound", currentDocuments: current },
    );
  }
  // Each document appears once in the binding and the binding covers the whole
  // current set, so a repeated entry cannot stand in for a missing document.
  const currentById = new Map(current.map((entry) => [entry.documentId, entry]));
  const matches =
    new Set(bound.map((entry) => entry.documentId)).size === bound.length &&
    bound.length === current.length &&
    bound.every((entry) => {
      const latest = currentById.get(entry.documentId);
      return latest?.revisionId === entry.revisionId &&
        latest.revisionNumber === entry.revisionNumber &&
        latest.key === entry.key;
    });
  if (!matches) {
    throw conflict(
      "The task documents changed after this completion was submitted. Request changes so the worker resubmits the current revisions.",
      {
        code: "native_completion_review_documents_stale",
        boundDocuments: bound,
        currentDocuments: current,
      },
    );
  }
  // Author exclusion governs an agent's independent content QA. A human
  // resolver keeps the existing audience rules (addressee, human_only) and may
  // judge documents they wrote; a system actor keeps its own existing rules.
  const agentId = input.actor.agentId;
  if (bound.length === 0 || !agentId) return;

  const boundNumber = new Map(bound.map((entry) => [entry.documentId, entry.revisionNumber]));
  const authored = await db
    .select({
      documentId: documentRevisions.documentId,
      revisionNumber: documentRevisions.revisionNumber,
      createdByAgentId: documentRevisions.createdByAgentId,
      runAgentId: heartbeatRuns.agentId,
    })
    .from(documentRevisions)
    .leftJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.id, documentRevisions.createdByRunId),
        eq(heartbeatRuns.companyId, input.companyId),
      ),
    )
    .where(
      and(
        eq(documentRevisions.companyId, input.companyId),
        inArray(documentRevisions.documentId, [...boundNumber.keys()]),
      ),
    );
  // An agent is an author if it recorded any revision up to the bound one,
  // through either the agent column or the creating run.
  const isAuthor = authored.some((row) =>
    row.revisionNumber <= (boundNumber.get(row.documentId) ?? 0) &&
    (row.createdByAgentId === agentId || row.runAgentId === agentId));
  if (isAuthor) {
    throw forbidden(
      "An author of the submitted documents cannot approve this completion. An independent reviewer must decide.",
      { code: "native_completion_review_author_excluded" },
    );
  }
}
