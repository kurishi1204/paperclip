import { createHash } from "node:crypto";
import { and, asc, eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assets,
  documentAnnotationComments,
  documentAnnotationThreads,
  documents,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueLabels,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Internal, content-free receipt. Persist this with an execution outbox before
 * sending anything externally; the receipt alone does not authorize a send.
 */
export type IssueRequirementSnapshot = {
  schemaVersion: 1;
  companyId: string;
  issueId: string;
  revision: number;
  materialSha256: string;
  counts: {
    documents: number;
    comments: number;
    relations: number;
    attachments: number;
    labels: number;
    annotationThreads: number;
    annotationComments: number;
    interactions: number;
  };
};

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/**
 * Read all native issue material while holding its serialization row. Child
 * table BEFORE triggers in migration 0313 take the same row lock before a
 * content change. Keep this inside a DB transaction; do not do network work
 * while the row is locked.
 */
export async function captureIssueRequirementSnapshotInTransaction(
  tx: Tx,
  input: { companyId: string; issueId: string },
): Promise<IssueRequirementSnapshot> {
  const [issue] = await tx
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
    .for("update");
  if (!issue) throw notFound("Issue not found");
  if (!Number.isSafeInteger(issue.revision) || issue.revision < 0) {
    throw conflict("Issue requirement revision cannot be represented safely");
  }

  const documentRows = await tx
    .select({ link: issueDocuments, document: documents })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.companyId, input.companyId), eq(issueDocuments.issueId, issue.id)))
    .orderBy(asc(issueDocuments.id));
  const commentRows = await tx
    .select()
    .from(issueComments)
    .where(and(eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, issue.id)))
    .orderBy(asc(issueComments.id));
  const relationRows = await tx
    .select()
    .from(issueRelations)
    .where(and(
      eq(issueRelations.companyId, input.companyId),
      or(eq(issueRelations.issueId, issue.id), eq(issueRelations.relatedIssueId, issue.id)),
    ))
    .orderBy(asc(issueRelations.id));
  const attachmentRows = await tx
    .select({ link: issueAttachments, asset: assets })
    .from(issueAttachments)
    .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
    .where(and(eq(issueAttachments.companyId, input.companyId), eq(issueAttachments.issueId, issue.id)))
    .orderBy(asc(issueAttachments.id));
  const labelRows = await tx
    .select({ labelId: issueLabels.labelId })
    .from(issueLabels)
    .where(and(eq(issueLabels.companyId, input.companyId), eq(issueLabels.issueId, issue.id)))
    .orderBy(asc(issueLabels.labelId));
  const annotationThreadRows = await tx
    .select()
    .from(documentAnnotationThreads)
    .where(and(
      eq(documentAnnotationThreads.companyId, input.companyId),
      eq(documentAnnotationThreads.issueId, issue.id),
    ))
    .orderBy(asc(documentAnnotationThreads.id));
  const annotationCommentRows = await tx
    .select({ comment: documentAnnotationComments })
    .from(documentAnnotationComments)
    .innerJoin(documentAnnotationThreads,
      eq(documentAnnotationComments.threadId, documentAnnotationThreads.id))
    .where(and(
      eq(documentAnnotationThreads.companyId, input.companyId),
      eq(documentAnnotationThreads.issueId, issue.id),
    ))
    .orderBy(asc(documentAnnotationComments.id));
  const interactionRows = await tx
    .select()
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, issue.id),
    ))
    .orderBy(asc(issueThreadInteractions.id));

  // Derived attribution and its bookkeeping timestamp can be populated on a
  // read. They do not change the authored instruction and do not bump revision.
  const comments = commentRows.map(({ derivedAuthorAgentId: _agentId,
    derivedCreatedByRunId: _runId, derivedAuthorSource: _source,
    updatedAt: _updatedAt, ...content }) => content);
  const material = canonical({
    schemaVersion: 1,
    issue,
    documents: documentRows,
    comments,
    relations: relationRows,
    attachments: attachmentRows,
    labels: labelRows,
    annotationThreads: annotationThreadRows,
    annotationComments: annotationCommentRows,
    interactions: interactionRows,
  });
  const materialSha256 = createHash("sha256").update(JSON.stringify(material)).digest("hex");
  return {
    schemaVersion: 1,
    companyId: issue.companyId,
    issueId: issue.id,
    revision: issue.revision,
    materialSha256,
    counts: {
      documents: documentRows.length,
      comments: commentRows.length,
      relations: relationRows.length,
      attachments: attachmentRows.length,
      labels: labelRows.length,
      annotationThreads: annotationThreadRows.length,
      annotationComments: annotationCommentRows.length,
      interactions: interactionRows.length,
    },
  };
}

export async function captureIssueRequirementSnapshot(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<IssueRequirementSnapshot> {
  return db.transaction((tx) => captureIssueRequirementSnapshotInTransaction(tx, input));
}

/** Use before a DB outbox write in the *same* transaction. */
export async function assertIssueRequirementSnapshotInTransaction(
  tx: Tx,
  frozen: IssueRequirementSnapshot,
): Promise<IssueRequirementSnapshot> {
  if (frozen.schemaVersion !== 1 || !Number.isSafeInteger(frozen.revision) ||
      !/^[0-9a-f]{64}$/.test(frozen.materialSha256)) {
    throw conflict("Invalid frozen issue requirement snapshot");
  }
  const current = await captureIssueRequirementSnapshotInTransaction(tx, frozen);
  if (current.revision !== frozen.revision || current.materialSha256 !== frozen.materialSha256) {
    throw conflict("Issue requirements changed since the frozen snapshot", {
      code: "issue_requirement_revision_conflict",
      currentRevision: current.revision,
    });
  }
  return current;
}
