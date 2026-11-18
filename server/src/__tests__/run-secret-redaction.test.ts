import { beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { issueService } from "../services/issues.js";
import type { Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { createRunSecretRedactionRegistry, redactRegisteredSecretValues } from "../services/run-secret-redaction.js";

const secret = "q2a-exact-secret-value";

describe("registered run secret redaction", () => {
  it("redacts exact values across comment and heartbeat/wake projections", () => {
    const result = redactRegisteredSecretValues({
      comment: { body: `agent pasted ${secret} in a comment` },
      heartbeatContext: {
        issue: { description: `do not expose ${secret}` },
        wakeComment: { body: secret },
      },
      wakePayload: {
        comments: [{ body: `prefix-${secret}-suffix` }],
        continuationSummary: { body: secret },
      },
    }, [secret]);

    expect(result).toEqual({
      comment: { body: `agent pasted ${REDACTED_EVENT_VALUE} in a comment` },
      heartbeatContext: {
        issue: { description: `do not expose ${REDACTED_EVENT_VALUE}` },
        wakeComment: { body: REDACTED_EVENT_VALUE },
      },
      wakePayload: {
        comments: [{ body: `prefix-${REDACTED_EVENT_VALUE}-suffix` }],
        continuationSummary: { body: REDACTED_EVENT_VALUE },
      },
    });
  });

  it("redacts run detail, event, and transcript fields and strips registry material", () => {
    const result = redactRegisteredSecretValues({
      contextSnapshot: {
        issueId: "issue-1",
        paperclipSecretRedactions: [{ material: { ciphertext: "encrypted" } }],
      },
      stdoutExcerpt: `stdout ${secret}`,
      events: [{ message: secret, payload: { output: secret } }],
      log: { content: `tool returned ${secret}` },
    }, [secret]);

    expect(result).toEqual({
      contextSnapshot: { issueId: "issue-1" },
      stdoutExcerpt: `stdout ${REDACTED_EVENT_VALUE}`,
      events: [{ message: REDACTED_EVENT_VALUE, payload: { output: REDACTED_EVENT_VALUE } }],
      log: { content: `tool returned ${REDACTED_EVENT_VALUE}` },
    });
  });

  it("replaces longer registered values before overlapping shorter values", () => {
    expect(redactRegisteredSecretValues("token-extended token", ["token-extended", "token"]))
      .toBe(`${REDACTED_EVENT_VALUE} ${REDACTED_EVENT_VALUE}`);
  });

  it("preserves Date instances instead of collapsing them to empty objects (PAP-16607)", () => {
    const createdAt = new Date("2026-08-06T12:00:00.000Z");
    const result = redactRegisteredSecretValues({
      comment: { body: `agent pasted ${secret}`, createdAt, updatedAt: createdAt },
      nested: [{ finishedAt: createdAt }],
    }, [secret]);

    expect(result.comment.createdAt).toBeInstanceOf(Date);
    expect(result.comment.createdAt.toISOString()).toBe("2026-08-06T12:00:00.000Z");
    expect(result.comment.updatedAt).toBeInstanceOf(Date);
    expect(result.nested[0]?.finishedAt).toBeInstanceOf(Date);
    expect(result.comment.body).toBe(`agent pasted ${REDACTED_EVENT_VALUE}`);
  });

  it("preserves Date instances when no secret values are registered", () => {
    const createdAt = new Date("2026-08-06T12:00:00.000Z");
    const result = redactRegisteredSecretValues({ createdAt }, []);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.toISOString()).toBe("2026-08-06T12:00:00.000Z");
  });
});

const { resolveVersion, getGeneral } = vi.hoisted(() => ({
  resolveVersion: vi.fn(async ({ material }) => material.value as string),
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({ getGeneral }) }));
vi.mock("../secrets/provider-registry.js", () => ({ getSecretProvider: () => ({ resolveVersion }) }));

describe("batched run secret redaction", () => {
  beforeEach(() => { resolveVersion.mockClear(); getGeneral.mockClear(); });

  function fixture(rows: unknown[]) {
    const where = vi.fn(async (_predicate: import("drizzle-orm").SQL | undefined) => rows);
    const select = vi.fn((_columns: { contextSnapshot: import("drizzle-orm").SQL }) => ({ from: () => ({ where }) }));
    return { registry: createRunSecretRedactionRegistry({ select } as unknown as Db), select, where };
  }

  it("reads only registry JSON once for 200 runs and resolves shared secrets once", async () => {
    const contextSnapshot = { paperclipSecretRedactions: [{ fingerprintSha256: "shared", material: { value: secret } }] };
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `run-${i}`, contextSnapshot }));
    const { registry, select, where } = fixture(rows);
    const result = await registry.redactForRuns("company-1", rows.map(row => ({ ...row, stdoutExcerpt: secret })));
    expect(select).toHaveBeenCalledTimes(1);
    expect(resolveVersion).toHaveBeenCalledTimes(1);
    expect(result.every(run => run.stdoutExcerpt === REDACTED_EVENT_VALUE)).toBe(true);
    expect(result[0].contextSnapshot).toEqual({});
    const dialect = new PgDialect();
    const predicate = dialect.sqlToQuery(where.mock.calls[0][0]);
    expect(predicate.params).toContain("company-1");
    expect(predicate.sql).toContain('"company_id"');
    expect(dialect.sqlToQuery(select.mock.calls[0][0].contextSnapshot).sql).toContain("-> 'paperclipSecretRedactions'");
  });

  it("keeps each run's registry separate and observes new registrations on the next request", async () => {
    const rows = [{ id: "a", contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "one", material: { value: secret } }] } }];
    const { registry } = fixture(rows);
    expect(await registry.redactForRuns("company", [{ id: "a", text: secret }, { id: "b", text: secret }]))
      .toEqual([{ id: "a", text: REDACTED_EVENT_VALUE }, { id: "b", text: secret }]);
    rows[0].contextSnapshot.paperclipSecretRedactions.push({ fingerprintSha256: "two", material: { value: "new-secret" } });
    expect(await registry.redactForRuns("company", [{ id: "a", text: "new-secret" }]))
      .toEqual([{ id: "a", text: REDACTED_EVENT_VALUE }]);
  });

  it("does not load username settings for empty issue comments and preserves nonempty deleted-comment redaction", async () => {
    const rows: unknown[] = [];
    const query: any = { from: () => query, where: () => query, orderBy: () => query, limit: () => query,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
    };
    const svc = issueService({ select: () => query } as unknown as Db);
    expect(await svc.listComments("issue-1")).toEqual([]);
    expect(getGeneral).not.toHaveBeenCalled();
    rows.push({ id: "comment-1", companyId: "company-1", issueId: "issue-1", body: secret,
      authorAgentId: "agent-1", authorUserId: null, createdByRunId: null,
      presentation: { kind: "system_notice" }, metadata: { text: secret }, deletedAt: new Date(),
    });
    const comments = await svc.listComments("issue-1");
    expect(getGeneral).toHaveBeenCalledTimes(1);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ body: "", presentation: null, metadata: null });
  });

  it("does not load issue-wide registries for empty comments, while nonempty issue results still redact and fail closed", async () => {
    const { registry, select } = fixture([{ id: "run-1", contextSnapshot: {
      paperclipSecretRedactions: [{ fingerprintSha256: "one", material: { value: secret } }],
    } }]);
    expect(await registry.redactForIssue("company-1", "issue-1", [])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    expect(resolveVersion).not.toHaveBeenCalled();
    expect(await registry.redactForIssue("company-1", "issue-1", [{ body: secret }]))
      .toEqual([{ body: REDACTED_EVENT_VALUE }]);
    expect(select).toHaveBeenCalledTimes(1);
    expect(resolveVersion).toHaveBeenCalledTimes(1);
    resolveVersion.mockRejectedValueOnce(new Error("unavailable"));
    await expect(registry.redactForIssue("company-1", "issue-1", [{ body: secret }])).rejects.toThrow("unavailable");
  });

  it.each(["asc", "desc"] as const)("preserves database cursor precision for %s comment pages", async (order) => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const cursorId = "22222222-2222-4222-8222-222222222222";
    const storedTimestamp = "2026-11-16 09:09:18.733001+00";
    const dialect = new PgDialect();
    const predicates: import("drizzle-orm").SQL[] = [];
    let projection: { createdAt: unknown } | undefined;
    const select = vi.fn((columns?: { createdAt: unknown }) => {
      const query: any = {
        from: () => query,
        where: (predicate: import("drizzle-orm").SQL) => { predicates.push(predicate); return query; },
        orderBy: () => query,
        limit: () => query,
        then: (resolve: (rows: unknown[]) => unknown) => {
          projection = columns ?? projection;
          // Model the existing timestamp driver's Date decode; SQL text preserves
          // all digits. No DB or process is started by this controlled consumer.
          const rawText = columns?.createdAt instanceof Object
            && "queryChunks" in columns.createdAt;
          return Promise.resolve(resolve(columns ? [{ id: cursorId,
            createdAt: rawText ? storedTimestamp : new Date("2026-11-16T09:09:18.733001Z"),
          }] : []));
        },
      };
      return query;
    });
    const svc = issueService({ select } as unknown as Db);
    expect(await svc.listComments(issueId, { afterCommentId: cursorId, order, limit: 1 })).toEqual([]);
    const page = dialect.sqlToQuery(predicates[1]);
    // With the old Date parameter, the asc predicate includes the cursor itself;
    // desc also loses preceding comments within the same millisecond.
    expect(new Date("2026-11-16T09:09:18.733001Z").toISOString()).toBe("2026-11-16T09:09:18.733Z");
    expect(page.params.filter(value => value === storedTimestamp)).toHaveLength(2);
    expect(page.params).toContain(issueId);
    expect(page.params).toContain(cursorId);
    expect(page.sql).toContain(order === "asc" ? " > " : " < ");
    expect(dialect.sqlToQuery(projection!.createdAt as import("drizzle-orm").SQL).sql).toContain("::text");
    expect(page.sql.match(/::timestamptz/g)).toHaveLength(2);
    expect(getGeneral).not.toHaveBeenCalled();
  });

  it("does not query for an empty list and fails closed on decryption failure", async () => {
    const { registry, select } = fixture([{ id: "a", contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "one", material: {} }] } }]);
    expect(await registry.redactForRuns("company", [])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    resolveVersion.mockRejectedValueOnce(new Error("unavailable"));
    await expect(registry.redactForRuns("company", [{ id: "a", text: secret }])).rejects.toThrow("unavailable");
  });
});
