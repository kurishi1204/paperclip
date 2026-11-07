import { and, asc, eq, inArray } from "drizzle-orm";
import {
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issues,
  type Db,
} from "@paperclipai/db";
import { isSystemIssueDocumentKey, type RequestConfirmationBoundDocument } from "@paperclipai/shared";
import { conflict, forbidden } from "../../errors.js";

type BindingActor = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

/**
 * Read every issue document revision that a completion submission carries.
 * The issue row is the serialization point for its documents: the
 * paperclip_bump_issue_revision_from_child triggers (migration 0313) lock it
 * FOR UPDATE before any issue_documents insert/update/delete or linked
 * documents update. Holding that lock, the set read here cannot gain, lose or
 * change a document until the caller commits. Callers already hold it, so this
 * repeats the same lock without a new order. Document rows are deliberately not
 * locked: a writer holds its document row before the trigger waits for the issue.
 */
export async function readNativeCompletionDocumentRevisions(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<RequestConfirmationBoundDocument[]> {
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
  // System documents (continuation summary, pipeline case body) are server
  // bookkeeping rewritten after runs, not submitted work.
  return rows.flatMap((row) =>
    row.revisionId && !isSystemIssueDocumentKey(row.key)
      ? [{
          documentId: row.documentId,
          key: row.key,
          revisionId: row.revisionId,
          revisionNumber: row.revisionNumber,
        }]
      : [],
  );
}

function readBoundDocuments(payload: unknown): RequestConfirmationBoundDocument[] | null {
  const target = payload && typeof payload === "object"
    ? (payload as { target?: { boundDocuments?: unknown } }).target
    : null;
  return Array.isArray(target?.boundDocuments)
    ? (target.boundDocuments as RequestConfirmationBoundDocument[])
    : null;
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
    payload: unknown;
    actor: BindingActor;
  },
) {
  const current = await readNativeCompletionDocumentRevisions(db, input);
  const bound = readBoundDocuments(input.payload);
  if (!bound) {
    // Cards recorded before revision binding existed carry no document set.
    // Only a task that still has no documents can be approved from them.
    if (current.length === 0) return;
    throw conflict(
      "This completion review did not record its document revisions. Request changes so the worker resubmits the current documents.",
      { code: "native_completion_review_documents_unbound", currentDocuments: current },
    );
  }
  const currentById = new Map(current.map((entry) => [entry.documentId, entry]));
  const matches =
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
