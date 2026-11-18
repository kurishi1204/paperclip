import { afterEach, describe, expect, it, vi } from "vitest";
import { Ajv, type AnySchema } from "ajv";
import { agents, documents, heartbeatRuns, issues } from "@paperclipai/db";
import * as interactionServices from "../issue-thread-interactions.js";
import * as documentServices from "../documents.js";
import * as activityServices from "../activity-log.js";
import * as identities from "../run-identity.js";
import { conflict } from "../../errors.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

// The original semantic consumer runs against controlled storage/service ports.
// This suite starts no database, provider, server or HTTP request.
describe("native document interaction withdrawal", () => {
  afterEach(() => vi.restoreAllMocks());
  function setup() {
    const binding = { companyId: "00000000-0000-4000-8000-000000000101", agentId: "00000000-0000-4000-8000-000000000102",
      issueId: "00000000-0000-4000-8000-000000000103", runId: "00000000-0000-4000-8000-000000000104" };
    const target = { type: "issue_document", issueId: binding.issueId, key: "duty",
      documentId: "00000000-0000-4000-8000-000000000105", revisionId: "00000000-0000-4000-8000-000000000106" };
    const interactionId = "00000000-0000-4000-8000-000000000107";
    const context = {
      run: { id: binding.runId, companyId: binding.companyId, agentId: binding.agentId, nativeIssueId: binding.issueId,
        runtimeMode: "native", status: "running", contextSnapshot: {}, resultJson: {} as Record<string, unknown> },
      issue: { id: binding.issueId, companyId: binding.companyId, assigneeAgentId: binding.agentId,
        executionRunId: binding.runId, status: "in_review", workMode: "standard", reviewPolicy: null as null | string },
      actor: { id: binding.agentId, companyId: binding.companyId, status: "active" },
    };
    const card = { id: interactionId, issueId: binding.issueId, companyId: binding.companyId,
      createdByAgentId: binding.agentId, kind: "request_confirmation", status: "pending",
      addresseeAgentId: "00000000-0000-4000-8000-000000000108", effectiveResolverPolicy: "anyone", payload: { target }, result: null as unknown };
    const document = { id: target.documentId, latestRevisionId: target.revisionId };
    let loseCommitAck = false;
    const db: any = {
      select(projection?: any) {
        let table: unknown;
        const rows = () => projection?.run ? [context] : table === documents ? [{ id: document.id }]
          : table === issues ? [{ id: binding.issueId }] : table === agents ? [{ id: binding.agentId }] : [];
        const q: any = { from(t: unknown) { table = t; return q; }, innerJoin() { return q; }, where() { return q; }, for() { return q; },
          limit() { return Promise.resolve(rows()); }, then(ok: any, fail: any) { return Promise.resolve(rows()).then(ok, fail); } };
        return q;
      },
      update(table: unknown) { return { set(value: any) { return { async where() {
        if (table === heartbeatRuns && value.resultJson) context.run.resultJson = value.resultJson;
      } }; } }; },
      async transaction(fn: any) {
        const result = await fn(db);
        if (loseCommitAck) { loseCommitAck = false; throw new Error("synthetic lost commit acknowledgement"); }
        return result;
      },
    };
    const withdraw = vi.fn(async () => {
      if (card.status !== "pending") throw conflict("The interaction is no longer pending");
      card.status = "cancelled"; card.result = { outcome: "withdrawn", reason: "Re-nominate the same fixed review" };
      return structuredClone(card);
    });
    vi.spyOn(interactionServices, "issueThreadInteractionService").mockReturnValue({
      getForIssue: vi.fn(async () => structuredClone(card)), withdrawInteraction: withdraw,
    } as never);
    vi.spyOn(documentServices, "documentService").mockReturnValue({ getIssueDocumentByKey: vi.fn(async () => document) } as never);
    const activity = vi.spyOn(activityServices, "persistActivity").mockResolvedValue({ publication: null } as never);
    vi.spyOn(identities, "captureRunIdentity").mockResolvedValue({ context: { id: "fixture-identity" } } as never);
    const enqueue = vi.fn();
    const authority = new PaperclipRunnerToolAuthority(db, { ...binding, enqueueWakeup: enqueue });
    const input = { operation: "withdraw", interactionId, idempotencyKey: "same-fixed-review-withdrawal",
      reason: "Re-nominate the same fixed review", payload: { target: structuredClone(target) } };
    const call = (arguments_: unknown = input) => authority.execute({ tool: "request_human_input", callId: "withdraw-call", arguments: arguments_ });
    return { authority, binding, target, card, document, context, input, call, withdraw, enqueue, activity,
      loseCommitAck() { loseCommitAck = true; } };
  }

  it("exposes the existing tool and saves one original withdrawal receipt without a new wake", async () => {
    const f = setup();
    const definition = f.authority.definitions().find(tool => tool.name === "request_human_input")!;
    const validate = new Ajv({ strict: false }).compile(definition.inputSchema as AnySchema);
    expect(validate(f.input), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ idempotencyKey: "old-create", interactionKind: "confirmation", title: "Existing create",
      prompt: "Same unchanged question", continuationPolicy: "none" })).toBe(true);
    expect(validate({ operation: "withdraw", idempotencyKey: "missing-target" })).toBe(false);
    const result = await f.call();
    expect(result).toMatchObject({ disposition: "applied", interaction: { status: "cancelled", result: { outcome: "withdrawn" } } });
    expect(f.context.run.resultJson).toHaveProperty("semanticToolReceipts.same-fixed-review-withdrawal");
    expect(await f.call()).toEqual(result);
    expect(f.withdraw).toHaveBeenCalledTimes(1);
    expect(f.activity).toHaveBeenCalledTimes(1);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it.each(["creator", "answered", "revision", "foreign-issue", "human-only", "plan", "review-policy", "stale-authority"])("preserves the %s refusal before the effect", async (condition) => {
    const f = setup();
    if (condition === "creator") f.card.createdByAgentId = "other-creator";
    if (condition === "answered") f.card.status = "accepted";
    if (condition === "revision") f.document.latestRevisionId = "new-revision";
    if (condition === "foreign-issue") f.input.payload.target.issueId = "other-issue";
    if (condition === "human-only") f.card.effectiveResolverPolicy = "human_only";
    if (condition === "plan") f.input.payload.target.key = "plan";
    if (condition === "review-policy") f.context.issue.reviewPolicy = "not_creator";
    if (condition === "stale-authority") f.context.issue.executionRunId = "replaced-run";
    await expect(f.call()).rejects.toThrow();
    expect(f.withdraw).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.context.run.resultJson).toEqual({});
  });

  it("reports a lost commit acknowledgement as unknown without automatically resending", async () => {
    const f = setup(); f.loseCommitAck();
    await expect(f.call()).rejects.toThrow("withdrawal_outcome_unknown");
    expect(f.card.status).toBe("cancelled");
    expect(f.context.run.resultJson).toHaveProperty("semanticToolReceipts.same-fixed-review-withdrawal");
    expect(f.withdraw).toHaveBeenCalledTimes(1);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
