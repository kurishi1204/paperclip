import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { documentService, extractLegacyPlanBody, lockPipelineCaseDocumentOwners } from "../services/documents.js";

describe("extractLegacyPlanBody", () => {
  it("returns null when no plan block exists", () => {
    expect(extractLegacyPlanBody("hello world")).toBeNull();
  });

  it("extracts plan body from legacy issue descriptions", () => {
    expect(
      extractLegacyPlanBody(`
intro

<plan>

# Plan

- one
- two

</plan>
      `),
    ).toBe("# Plan\n\n- one\n- two");
  });

  it("ignores empty plan blocks", () => {
    expect(extractLegacyPlanBody("<plan>   </plan>")).toBeNull();
  });
});


describe("document creation conflicts", () => {
  function serviceWithTransactionError(error: Error) {
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: "issue-1", companyId: "company-1" }]),
        }),
      }),
      transaction: vi.fn().mockRejectedValue(error),
    };
    return documentService(db as unknown as Db);
  }

  const input = { issueId: "issue-1", key: "plan", format: "markdown", body: "# Plan" };

  it("returns a retryable conflict for a Drizzle-wrapped concurrent insert", async () => {
    const error = new Error("Failed query: insert into issue_documents", {
      cause: Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint_name: "issue_documents_company_issue_key_uq",
      }),
    });
    await expect(serviceWithTransactionError(error).upsertIssueDocument(input)).rejects.toMatchObject({
      status: 409,
      message: "Document key already exists on this issue",
      details: { key: "plan" },
    });
  });

  it.each([
    { code: "23503", constraint_name: "issue_documents_issue_id_issues_id_fk" },
    { code: "23505", constraint_name: "document_revisions_document_revision_uq" },
    { code: "23505", constraint_name: "issue_documents_document_uq" },
  ])("preserves unrelated database failures ($constraint_name)", async (cause) => {
    const error = new Error("Failed query", { cause });
    await expect(serviceWithTransactionError(error).upsertIssueDocument(input)).rejects.toBe(error);
  });
});

// Controlled SQL adapter only: this checks the original service transaction and
// read/digest consumers, not PostgreSQL locking, triggers, or durable commit.
describe("document append transaction", () => {
  const revisionId = "00000000-0000-4000-8000-000000000111";
  const nextId = "00000000-0000-4000-8000-000000000222";
  const original = "  合成本文😀e\u0301\r\n旧一語\\n\n".repeat(1800);
  function fixture(overrides: Record<string, unknown> = {}) {
    const row = { id: "doc", issueId: "issue", companyId: "company", key: "report",
      latestBody: original, latestRevisionId: revisionId, latestRevisionNumber: 14,
      lockedAt: null, ...overrides };
    const events: string[] = [];
    let saved: Record<string, any> | undefined;
    function query(rows: unknown[]) {
      const q: any = { from: () => q, innerJoin: () => q, where: () => q,
        limit: () => q, for: (mode: string) => { events.push(`lock:${mode}`); return q; },
        then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject) };
      return q;
    }
    const tx = {
      select: (shape: Record<string, unknown>) => { events.push("select"); return query("latestBody" in shape ? [row] : "body" in shape ? [{ id: "old-revision", documentId: "doc", companyId: "company", body: "restored", revisionNumber: 1, format: "markdown" }] : [{ id: "issue" }]); },
      insert: vi.fn(() => ({ values: (value: Record<string, any>) => {
        saved = { ...value, id: nextId }; return { returning: async () => [saved] };
      } })),
      delete: vi.fn(() => ({ where: async () => { events.push("delete"); } })),
      update: () => ({ set: (value: Record<string, unknown>) => ({ where: async () => {
        if ("latestBody" in value) Object.assign(row, value);
      } }) }),
    };
    let reading = false;
    const db = {
      transaction: async (fn: (value: unknown) => unknown) => fn(tx),
      select: (shape: Record<string, unknown>) => query(reading
        ? ("revisionId" in shape ? [{ documentId: row.id, revisionId: nextId, revisionNumber: 15, body: saved?.body }] : [row])
        : [{ id: "issue", companyId: "company" }]),
    };
    return { svc: documentService(db as unknown as Db), tx, events, row,
      saved: () => saved, read: () => { reading = true; } };
  }
  const input = { issueId: "issue", key: "report", format: "markdown", append: "\r\n追記😀  \\n\n", baseRevisionId: revisionId };
  it("preserves the full base bytes through the original write, read and digest consumers", async () => {
    const f = fixture();
    const result = await f.svc.upsertIssueDocument(input);
    const expected = Buffer.concat([Buffer.from(original), Buffer.from(input.append)]);
    expect(f.saved()!.body).toBe(expected.toString());
    expect(f.events.slice(0, 3)).toEqual(["select", "lock:update", "select"]);
    expect(Buffer.from(f.saved()!.body)).toEqual(expected);
    expect(Buffer.from(f.row.latestBody)).toEqual(expected);
    expect(result.document.latestRevisionNumber).toBe(15);
    f.read();
    expect((await f.svc.getIssueDocumentByKey("issue", "report"))!.body).toBe(expected.toString());
    const digest = await f.svc.getIssueDocumentRevisionDigest({ companyId: "company", issueId: "issue", key: "report", revisionId: nextId });
    expect(digest).toMatchObject({ bodyBytes: expected.length, bodySha256: createHash("sha256").update(expected).digest("hex") });
  });
  it("rejects a stale or locked base before inserting, including create-new policy", async () => {
    for (const overrides of [{ latestRevisionId: nextId }, { lockedAt: new Date() }]) {
      const f = fixture(overrides);
      await expect(f.svc.upsertIssueDocument({ ...input, lockedDocumentStrategy: "create_new_document" })).rejects.toMatchObject({ status: 409 });
      expect(f.tx.insert).not.toHaveBeenCalled();
    }
  });
  it("locks the issue before restore, lock, unlock and delete read their current document", async () => {
    for (const operation of ["restore", "lock", "unlock", "delete"] as const) {
      const f = fixture(operation === "unlock" ? { lockedAt: new Date() } : {});
      if (operation === "restore") {
        const result = await f.svc.restoreIssueDocumentRevision({ issueId: "issue", key: "report", revisionId: "old-revision" });
        expect(result.document.body).toBe("restored");
      } else if (operation === "lock") {
        expect((await f.svc.lockIssueDocument({ issueId: "issue", key: "report" })).changed).toBe(true);
      } else if (operation === "unlock") {
        expect((await f.svc.unlockIssueDocument("issue", "report")).changed).toBe(true);
      } else {
        expect((await f.svc.deleteIssueDocument("issue", "report"))!.body).toBe(original);
        expect(f.tx.delete).toHaveBeenCalledTimes(2);
      }
      expect(f.events.slice(0, 3)).toEqual(["select", "lock:update", "select"]);
    }
  });
  it("preserves locked restore/delete rejection and idempotent lock/unlock", async () => {
    for (const operation of ["restore", "delete"] as const) {
      const f = fixture({ lockedAt: new Date() });
      await expect(operation === "restore"
        ? f.svc.restoreIssueDocumentRevision({ issueId: "issue", key: "report", revisionId: "old-revision" })
        : f.svc.deleteIssueDocument("issue", "report")).rejects.toMatchObject({ status: 409 });
      expect(f.tx.insert).not.toHaveBeenCalled();
      expect(f.tx.delete).not.toHaveBeenCalled();
    }
    expect((await fixture({ lockedAt: new Date() }).svc.lockIssueDocument({ issueId: "issue", key: "report" })).changed).toBe(false);
    expect((await fixture().svc.unlockIssueDocument("issue", "report")).changed).toBe(false);
  });
  it("rejects invalid raw suffixes and the combined UTF-8 byte limit", async () => {
    for (const append of ["", "\u0000", "\ud800", "😀".repeat(50_000)]) {
      const f = fixture();
      await expect(f.svc.upsertIssueDocument({ ...input, append })).rejects.toMatchObject({ status: 422 });
      expect(f.tx.insert).not.toHaveBeenCalled();
    }
  });
});


// Controlled query results: exercises the shared-owner lock/re-read contract,
// not real database scheduling or transaction rollback.
describe("shared pipeline document owner locks", () => {
  const link = { documentId: "doc", issueId: "z-owner", companyId: "company" };
  function fixture(before = [link], after = before, locked = [{ id: "a-next" }, { id: "z-owner" }]) {
    const events: string[] = [];
    const queries: { where?: ReturnType<PgDialect["sqlToQuery"]>; order: string[] }[] = [];
    let reads = 0;
    const dialect = new PgDialect();
    const tx = { select: (shape: Record<string, unknown>) => {
      const owners = "documentId" in shape;
      const rows = owners ? (reads++ === 0 ? before : after) : locked;
      events.push(owners ? "read-links" : "read-issues");
      const recorded: typeof queries[number] = { order: [] };
      queries.push(recorded);
      const q: any = {
        from: () => q, innerJoin: () => q,
        where: (value: Parameters<PgDialect["sqlToQuery"]>[0]) => { recorded.where = dialect.sqlToQuery(value); return q; },
        orderBy: (value: Parameters<PgDialect["sqlToQuery"]>[0]) => { recorded.order.push(dialect.sqlToQuery(value).sql); return q; },
        for: (mode: string) => { events.push("lock:" + mode); return q; },
        then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
      };
      return q;
    } };
    return { tx: tx as unknown as Pick<Db, "select">, events, queries };
  }
  const input = { companyId: "company", caseId: "case", key: "body", additionalIssueIds: ["z-owner", "a-next"] };
  it("locks deduplicated current and next owners in SQL ID order before re-reading the shared link", async () => {
    const f = fixture();
    expect([...await lockPipelineCaseDocumentOwners(f.tx, input)]).toEqual(["a-next", "z-owner"]);
    expect(f.events).toEqual(["read-links", "read-issues", "lock:update", "read-links"]);
    expect(f.queries[1]!.where!.params).toEqual(["company", "a-next", "z-owner"]);
    expect(f.queries[1]!.order).toEqual(['"issues"."id" asc']);
  });
  it("rejects a changed or removed link after waiting for its owner", async () => {
    for (const after of [[], [{ ...link, issueId: "other-owner" }], [{ ...link, documentId: "other-doc" }]]) {
      const f = fixture([link], after);
      await expect(lockPipelineCaseDocumentOwners(f.tx, input)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("owner changed") });
      expect(f.events.at(-1)).toBe("read-links");
    }
  });
  it("rejects a foreign-company owner or missing owner rather than writing without its lock", async () => {
    const foreign = fixture([{ ...link, companyId: "other-company" }]);
    await expect(lockPipelineCaseDocumentOwners(foreign.tx, input)).rejects.toMatchObject({ status: 409 });
    expect(foreign.events).toEqual(["read-links"]);
    const missing = fixture([link], [link], [{ id: "a-next" }]);
    await expect(lockPipelineCaseDocumentOwners(missing.tx, input)).rejects.toMatchObject({ status: 409, message: "Shared document owner unavailable" });
  });
  it("allows an unshared document only after a stable empty-link re-read", async () => {
    const f = fixture([], [], []);
    expect([...await lockPipelineCaseDocumentOwners(f.tx, { ...input, additionalIssueIds: [] })]).toEqual([]);
    expect(f.events).toEqual(["read-links", "read-links"]);
  });
});
