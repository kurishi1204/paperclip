import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, issueThreadInteractions } from "@paperclipai/db";
import { documentService } from "../documents.js";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { runnerApiMutationRestriction } from "./runner-api-policy.js";

describe("dedicated fixed-document reviewer handoff", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  beforeAll(async () => { server = await startRunnerApiTestServer(); }, 60_000);
  afterAll(async () => { await server?.close(); });
  async function seed(mode: "standard" | "planning" | "ask" = "standard") {
    const f = await server.fixture({ disableWakeOnDemand: true, mode });
    const reviewerId = randomUUID();
    await server.db.insert(agents).values({ id: reviewerId, companyId: f.companyId,
      name: "Independent fixture reviewer", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } }, status: "active" });
    const doc = (await documentService(server.db).getIssueDocumentByKey(f.issueId, "notes"))!;
    const args = { idempotencyKey: randomUUID(), interactionKind: "confirmation",
      title: "Review saved notes", prompt: "Review this exact saved revision independently.",
      addresseeAgentId: reviewerId, continuationPolicy: "wake_assignee",
      payload: { target: { type: "issue_document", issueId: f.issueId, key: doc.key,
        documentId: doc.id, revisionId: doc.latestRevisionId } } };
    const call = (arguments_: Record<string, unknown> = args) => f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: arguments_ });
    return { f, reviewerId, doc, args, call };
  }
  it("binds the existing other employee and exact saved document once", async () => {
    const { f, reviewerId, doc, args, call } = await seed();
    const first = await call() as any;
    expect(first.interaction.addresseeAgentId, "fixed document reviewer must not be dropped").toBe(reviewerId);
    expect(first.interaction).toMatchObject({ addresseeAgentId: reviewerId, createdByAgentId: f.agentId,
      sourceRunId: f.runId, payload: { target: { type: "issue_document", documentId: doc.id, revisionId: doc.latestRevisionId } } });
    const retry = await call(args) as any;
    expect(retry.interaction.id).toBe(first.interaction.id);
    expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toHaveLength(1);
    const definition = f.authority.definitions().find(t => t.name === "request_human_input")!;
    expect(JSON.stringify(definition.inputSchema)).toContain("addresseeAgentId");
  });
  it("preserves the human-only company cap without forwarding a weaker resolver policy", async () => {
    const { f, reviewerId, call } = await seed();
    await server.db.update(companies).set({ interactionResolverGovernance: { request_confirmation: { defaultPolicy: "human_only", cap: "human_only" } } }).where(eq(companies.id, f.companyId));
    await expect(call()).rejects.toThrow("human-only");
    expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toHaveLength(0);
    const [company] = await server.db.select().from(companies).where(eq(companies.id, f.companyId));
    expect(company.interactionResolverGovernance).toEqual({ request_confirmation: { defaultPolicy: "human_only", cap: "human_only" } });
  });
  it("does not turn an ordinary human question into an employee request", async () => {
    const { f, args, call } = await seed();
    await expect(call({ ...args, interactionKind: "questions" })).rejects.toThrow("document_review_requires_fixed_confirmation");
    expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toHaveLength(0);
  });
  it("requires a complete same-task document target and rejects governed actions", async () => {
    const { f, args, call } = await seed();
    for (const target of [{ type: "custom", key: "ordinary" }, { ...args.payload.target, issueId: randomUUID() }, { ...args.payload.target, documentId: undefined }]) {
      await expect(call({ ...args, payload: { target } })).rejects.toThrow("document_review_requires_fixed_confirmation");
    }
    await expect(call({ ...args, payload: { ...args.payload, toolAction: {} } })).rejects.toThrow("document_review_requires_fixed_confirmation");
    expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toHaveLength(0);
  });
  it("retains same-company and independent reviewer checks", async () => {
    const { f, args, call } = await seed();
    await expect(call({ ...args, addresseeAgentId: f.agentId })).rejects.toThrow("themselves");
    await expect(call({ ...args, addresseeAgentId: randomUUID() })).rejects.toThrow("same company");
    expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toHaveLength(0);
  });
  it("keeps Ask mode read-only while ordinary human questions remain separate", async () => {
    const { f, call } = await seed("ask");
    await expect(call()).rejects.toThrow("document_review_requires_fixed_confirmation");
    expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toHaveLength(0);
  });
  it("rejects the document creator or latest editor before creating a review", async () => {
    for (const creator of [true, false]) {
      const { f, reviewerId, doc, args, call } = await seed();
      const key = creator ? "reviewer-owned" : "notes";
      await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key,
        title: "Reviewer authored notes", format: "markdown", body: "Synthetic reviewer-authored content.",
        baseRevisionId: creator ? null : doc.latestRevisionId, changeSummary: null,
        createdByAgentId: reviewerId, createdByRunId: null });
      const current = (await documentService(server.db).getIssueDocumentByKey(f.issueId, key))!;
      await expect(call({ ...args, payload: { target: { ...args.payload.target, key,
        documentId: current.id, revisionId: current.latestRevisionId } } })).rejects.toThrow("independent of the document");
      expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toHaveLength(0);
    }
  });
  it("allows one pending reviewer binding under concurrent different retry keys", async () => {
    const { f, args, call } = await seed();
    const results = await Promise.allSettled([call(), call({ ...args, idempotencyKey: randomUUID() })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toHaveLength(1);
  });
  it("isolates document QA from unrelated human confirmations and the sweeper", async () => {
    const { f, args, call } = await seed();
    const named = await call() as any;
    const humanArgs = { ...args, addresseeAgentId: null, idempotencyKey: randomUUID(),
      title: "Unrelated human confirmation", payload: { target: { type: "custom", key: "ordinary-human-question" } } };
    const oldHuman = await call(humanArgs) as any;
    const human = await call({ ...humanArgs, idempotencyKey: randomUUID(), title: "Updated human confirmation" }) as any;
    await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key: "next-notes", title: "Next notes", format: "markdown", body: "Another independent synthetic document.", baseRevisionId: null, changeSummary: null, createdByAgentId: f.agentId, createdByRunId: f.runId });
    const doc = (await documentService(server.db).getIssueDocumentByKey(f.issueId, "next-notes"))!;
    const otherNamed = await call({ ...args, idempotencyKey: randomUUID(), payload: { target: { ...args.payload.target, key: doc.key, documentId: doc.id, revisionId: doc.latestRevisionId } } }) as any;
    const { issueThreadInteractionService } = await import("../issue-thread-interactions.js");
    await issueThreadInteractionService(server.db).sweepSupersededPendingRequestConfirmations();
    const rows = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    const status = (id: string) => rows.find(r => r.id === id)?.status;
    expect(status(named.interaction.id)).toBe("pending");
    expect(status(otherNamed.interaction.id)).toBe("pending");
    expect(status(human.interaction.id)).toBe("pending");
    expect(status(oldHuman.interaction.id)).toBe("expired");
  });
  it("keeps creation and decision escape hatches closed", () => {
    expect(runnerApiMutationRestriction("/api/issues/{id}/interactions")).not.toBeNull();
    expect(runnerApiMutationRestriction("/api/issues/{id}/interactions/{interactionId}/accept")).not.toBeNull();
  });
});
