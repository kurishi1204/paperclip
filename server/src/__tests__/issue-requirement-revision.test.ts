import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assets,
  companies,
  createDb,
  documents,
  documentAnnotationComments,
  documentAnnotationThreads,
  issueAttachments,
  issueComments,
  issueLabels,
  issueRelations,
  issueThreadInteractions,
  issues,
  labels,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentService } from "../services/documents.js";
import { issueService } from "../services/issues.js";
import {
  assertIssueRequirementSnapshotInTransaction,
  captureIssueRequirementSnapshot,
  captureIssueRequirementSnapshotInTransaction,
} from "../services/issue-requirement-snapshot.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("issue requirement revision", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const issueId = randomUUID();
  const blockerId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-requirement-revision-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Requirement revision test",
      issuePrefix: "REQ",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Request", status: "backlog", priority: "medium" },
      { id: blockerId, companyId, title: "Blocker", status: "backlog", priority: "medium" },
    ]);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function revision(id: string): Promise<number> {
    const [row] = await db.select({ revision: issues.revision }).from(issues).where(eq(issues.id, id));
    return row!.revision;
  }

  it("invalidates a stale conditional edit for a new native comment", async () => {
    const before = await revision(issueId);
    await db.insert(issueComments).values({ companyId, issueId, authorType: "user", body: "Additional requirement" });
    expect(await revision(issueId)).toBe(before + 1);
    await expect(issueService(db).update(issueId, {
      expectedRevision: before,
      title: "Stale title",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("advances the same revision for native document and both relation endpoints", async () => {
    const beforeDocument = await revision(issueId);
    await documentService(db).upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "Initial requirement",
    });
    const afterCreate = await revision(issueId);
    expect(afterCreate).toBeGreaterThan(beforeDocument);
    const document = await documentService(db).getIssueDocumentByKey(issueId, "plan");
    await documentService(db).upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "Changed requirement",
      baseRevisionId: document!.latestRevisionId,
    });
    expect(await revision(issueId)).toBeGreaterThan(afterCreate);

    const beforeRelation = await revision(issueId);
    const beforeBlocker = await revision(blockerId);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    expect(await revision(issueId)).toBe(beforeRelation + 1);
    expect(await revision(blockerId)).toBe(beforeBlocker + 1);
    const [edge] = await db.select({ id: issueRelations.id }).from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, issueId));
    await db.delete(issueRelations).where(eq(issueRelations.id, edge!.id));
    expect(await revision(issueId)).toBe(beforeRelation + 2);
    expect(await revision(blockerId)).toBe(beforeBlocker + 2);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
  });

  it("freezes the complete native material as a stable digest and rejects a changed request", async () => {
    const input = { companyId, issueId };
    const frozen = await captureIssueRequirementSnapshot(db, input);
    expect(frozen).toMatchObject({
      companyId,
      issueId,
      counts: { comments: 1, documents: 1, relations: 1 },
    });
    expect(frozen.materialSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await captureIssueRequirementSnapshot(db, input)).toEqual(frozen);

    const [comment] = await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId));
    await db.update(issueComments).set({ updatedAt: new Date() }).where(eq(issueComments.id, comment!.id));
    expect(await captureIssueRequirementSnapshot(db, input)).toEqual(frozen);

    await db.update(issueComments).set({ body: "Revised requirement" }).where(eq(issueComments.id, comment!.id));
    const current = await captureIssueRequirementSnapshot(db, input);
    expect(current.revision).toBe(frozen.revision + 1);
    expect(current.materialSha256).not.toBe(frozen.materialSha256);
    await expect(db.transaction((tx) => assertIssueRequirementSnapshotInTransaction(tx, frozen)))
      .rejects.toMatchObject({ status: 409 });
    await expect(db.transaction((tx) => assertIssueRequirementSnapshotInTransaction(tx, current)))
      .resolves.toEqual(current);
  });

  it("pins label membership and rejects a wrong-company freeze", async () => {
    const labelId = randomUUID();
    await db.insert(labels).values({ id: labelId, companyId, name: "scope", color: "#ffffff" });
    const before = await captureIssueRequirementSnapshot(db, { companyId, issueId });
    await db.insert(issueLabels).values({ companyId, issueId, labelId });
    const after = await captureIssueRequirementSnapshot(db, { companyId, issueId });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.materialSha256).not.toBe(before.materialSha256);
    expect(after.counts.labels).toBe(1);
    await expect(captureIssueRequirementSnapshot(db, { companyId: randomUUID(), issueId }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("includes direct document and attachment metadata changes in the freeze", async () => {
    const input = { companyId, issueId };
    const beforeDocument = await captureIssueRequirementSnapshot(db, input);
    const document = await documentService(db).getIssueDocumentByKey(issueId, "plan");
    await db.update(documents).set({ title: "Updated plan title" }).where(eq(documents.id, document!.id));
    const afterDocument = await captureIssueRequirementSnapshot(db, input);
    expect(afterDocument.revision).toBe(beforeDocument.revision + 1);
    expect(afterDocument.materialSha256).not.toBe(beforeDocument.materialSha256);

    const assetId = randomUUID();
    await db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "local_disk",
      objectKey: "synthetic/request.txt",
      contentType: "text/plain",
      byteSize: 3,
      sha256: "a".repeat(64),
    });
    await db.insert(issueAttachments).values({ companyId, issueId, assetId });
    const afterAttach = await captureIssueRequirementSnapshot(db, input);
    expect(afterAttach.revision).toBe(afterDocument.revision + 1);
    expect(afterAttach.counts.attachments).toBe(1);

    await db.update(assets).set({ sha256: "b".repeat(64) }).where(eq(assets.id, assetId));
    const afterAssetMetadata = await captureIssueRequirementSnapshot(db, input);
    expect(afterAssetMetadata.revision).toBe(afterAttach.revision + 1);
    expect(afterAssetMetadata.materialSha256).not.toBe(afterAttach.materialSha256);
  });

  it("holds the issue lock before a concurrent child comment can commit", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const frozenTx = db.transaction(async (tx) => {
      await captureIssueRequirementSnapshotInTransaction(tx, { companyId, issueId });
      entered();
      await gate;
    });
    await ready;
    try {
      await expect(db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '150ms'`);
        await tx.insert(issueComments).values({ companyId, issueId, authorType: "user", body: "Racing instruction" });
      })).rejects.toMatchObject({ cause: { code: "55P03" } });
    } finally {
      release();
      await frozenTx;
    }
  });

  it("versions issue document annotation threads and comments on every mutation", async () => {
    const annotatedIssueId = randomUUID();
    await db.insert(issues).values({
      id: annotatedIssueId, companyId, title: "Annotated request", status: "backlog", priority: "medium",
    });
    await documentService(db).upsertIssueDocument({
      issueId: annotatedIssueId, key: "plan", title: "Plan", format: "markdown", body: "Alpha plan",
    });
    const document = await documentService(db).getIssueDocumentByKey(annotatedIssueId, "plan");
    expect(document).toBeTruthy();
    const input = { companyId, issueId: annotatedIssueId };
    const threadId = randomUUID();
    const commentId = randomUUID();
    const changed = async (mutate: () => Promise<unknown>) => {
      const before = await captureIssueRequirementSnapshot(db, input);
      await mutate();
      const after = await captureIssueRequirementSnapshot(db, input);
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(after.materialSha256).not.toBe(before.materialSha256);
      await expect(db.transaction((tx) => assertIssueRequirementSnapshotInTransaction(tx, before)))
        .rejects.toMatchObject({ status: 409 });
      return after;
    };

    let snapshot = await changed(() => db.insert(documentAnnotationThreads).values({
      id: threadId, companyId, issueId: annotatedIssueId, documentId: document!.id,
      documentKey: "plan", originalRevisionNumber: 1, currentRevisionNumber: 1,
      selectedText: "Alpha", normalizedStart: 0, normalizedEnd: 5,
      markdownStart: 0, markdownEnd: 5,
      anchorSelector: {
        quote: { exact: "Alpha", prefix: "", suffix: "" },
        position: { normalizedStart: 0, normalizedEnd: 5, markdownStart: 0, markdownEnd: 5 },
      },
    }));
    expect(snapshot.counts.annotationThreads).toBe(1);
    snapshot = await changed(() => db.update(documentAnnotationThreads)
      .set({ status: "resolved" }).where(eq(documentAnnotationThreads.id, threadId)));
    snapshot = await changed(() => db.insert(documentAnnotationComments).values({
      id: commentId, companyId, threadId, issueId: annotatedIssueId,
      documentId: document!.id, body: "Use the second option", authorType: "user",
    }));
    expect(snapshot.counts.annotationComments).toBe(1);
    snapshot = await changed(() => db.update(documentAnnotationComments)
      .set({ body: "Use the third option" }).where(eq(documentAnnotationComments.id, commentId)));
    snapshot = await changed(() => db.delete(documentAnnotationComments)
      .where(eq(documentAnnotationComments.id, commentId)));
    expect(snapshot.counts.annotationComments).toBe(0);
    snapshot = await changed(() => db.delete(documentAnnotationThreads)
      .where(eq(documentAnnotationThreads.id, threadId)));
    expect(snapshot.counts.annotationThreads).toBe(0);
  });

  it("versions a human question and its answer, including answer revision and deletion", async () => {
    const questionIssueId = randomUUID();
    await db.insert(issues).values({
      id: questionIssueId, companyId, title: "Question request", status: "backlog", priority: "medium",
    });
    const input = { companyId, issueId: questionIssueId };
    const interactionId = randomUUID();
    const changed = async (mutate: () => Promise<unknown>) => {
      const before = await captureIssueRequirementSnapshot(db, input);
      await mutate();
      const after = await captureIssueRequirementSnapshot(db, input);
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(after.materialSha256).not.toBe(before.materialSha256);
      await expect(db.transaction((tx) => assertIssueRequirementSnapshotInTransaction(tx, before)))
        .rejects.toMatchObject({ status: 409 });
      return after;
    };
    let snapshot = await changed(() => db.insert(issueThreadInteractions).values({
      id: interactionId, companyId, issueId: questionIssueId, kind: "ask_user_questions",
      payload: { version: 1, questions: [{
        id: "direction", prompt: "Which direction?", selectionMode: "single",
        options: [{ id: "first", label: "First" }, { id: "second", label: "Second" }],
      }] },
    }));
    expect(snapshot.counts.interactions).toBe(1);
    snapshot = await changed(() => db.update(issueThreadInteractions).set({
      status: "answered", result: { version: 1, answers: [{ questionId: "direction", optionIds: ["first"] }] },
    }).where(eq(issueThreadInteractions.id, interactionId)));
    snapshot = await changed(() => db.update(issueThreadInteractions).set({
      result: { version: 1, answers: [{ questionId: "direction", optionIds: ["second"] }] },
    }).where(eq(issueThreadInteractions.id, interactionId)));
    expect(snapshot.counts.interactions).toBe(1);
    snapshot = await changed(() => db.delete(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId)));
    expect(snapshot.counts.interactions).toBe(0);
  });
});
