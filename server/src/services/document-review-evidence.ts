import { and, eq } from "drizzle-orm";
import { documents, documentRevisions, issueDocuments, type Db } from "@paperclipai/db";
import { requestConfirmationPayloadSchema, type RequestConfirmationPayload } from "@paperclipai/shared";

type Evidence = NonNullable<RequestConfirmationPayload["supportingDocuments"]>;

/** Validate saved evidence under the same company/issue; caller prose grants nothing.
 * A changed revision invalidates admission, never substitutes the latest body. */
export async function readDocumentReviewEvidence(db: Db, input: {
  companyId: string; issueId: string; reviewerId: string; payload: unknown; lock?: boolean;
}): Promise<Evidence | null> {
  const parsed = requestConfirmationPayloadSchema.safeParse(input.payload);
  if (!parsed.success) return null;
  const payload = parsed.data;
  if (payload.supportingDocuments === undefined) return [];
  const target = payload.target;
  if (target?.type !== "issue_document" || target.issueId !== input.issueId ||
      !target.documentId || payload.toolAction || payload.secretProposal) return null;
  const keys = new Set([target.key]), ids = new Set([target.documentId]);
  for (const scope of payload.supportingDocuments) {
    if (scope.companyId !== input.companyId || scope.issueId !== input.issueId ||
        keys.has(scope.key) || ids.has(scope.documentId)) return null;
    keys.add(scope.key); ids.add(scope.documentId);
    const query = db.select({ document: { createdByAgentId: documents.createdByAgentId, createdByUserId: documents.createdByUserId,
      updatedByAgentId: documents.updatedByAgentId }, revision: { createdByAgentId: documentRevisions.createdByAgentId,
      createdByUserId: documentRevisions.createdByUserId } })
      .from(issueDocuments).innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .innerJoin(documentRevisions, eq(documentRevisions.documentId, documents.id))
      .where(and(eq(issueDocuments.companyId, input.companyId), eq(issueDocuments.issueId, input.issueId),
        eq(issueDocuments.key, scope.key), eq(documents.companyId, input.companyId),
        eq(documents.id, scope.documentId), eq(documents.latestRevisionId, scope.revisionId),
        eq(documents.latestRevisionNumber, scope.revisionNumber), eq(documentRevisions.companyId, input.companyId),
        eq(documentRevisions.id, scope.revisionId), eq(documentRevisions.revisionNumber, scope.revisionNumber)));
    const rows = await (input.lock ? query.for("share", { of: [documents, issueDocuments, documentRevisions] }) : query);
    if (rows.length !== 1) return null;
    const { document, revision } = rows[0]!;
    if (!(document.createdByAgentId || document.createdByUserId) ||
        !(revision.createdByAgentId || revision.createdByUserId) ||
        document.createdByAgentId === input.reviewerId || document.updatedByAgentId === input.reviewerId ||
        revision.createdByAgentId === input.reviewerId) return null;
  }
  return payload.supportingDocuments;
}
