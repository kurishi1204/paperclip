import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, heartbeatRuns, issues, issueThreadInteractions, activityLog, issueComments } from "@paperclipai/db";
import { documentService } from "../documents.js";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
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
  it("keeps plan adoption out of business-document QA", async () => {
    for (const mode of ["standard", "planning"] as const) {
      const { f, args, call } = await seed(mode);
      await documentService(server.db).upsertIssueDocument({ issueId:f.issueId,key:"plan",title:"Owner plan",format:"markdown",body:"Synthetic plan approval is distinct from employee QA.",baseRevisionId:null,changeSummary:null,createdByAgentId:f.agentId,createdByRunId:f.runId });
      const plan=(await documentService(server.db).getIssueDocumentByKey(f.issueId,"plan"))!;
      await expect(call({...args,payload:{target:{type:"issue_document",issueId:f.issueId,key:"plan",documentId:plan.id,revisionId:plan.latestRevisionId}}})).rejects.toThrow("document_review_requires_fixed_confirmation");
      expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId,f.issueId))).toHaveLength(0);
    }
  });
  it("enforces the same business scope at the common service entry", async () => {
    for (const mode of ["ask", "planning"] as const) {
      const {f,args}=await seed(mode);
      await expect(issueThreadInteractionService(server.db).create({id:f.issueId,companyId:f.companyId},{kind:"request_confirmation",addresseeAgentId:args.addresseeAgentId,idempotencyKey:args.idempotencyKey,sourceRunId:f.runId,title:args.title,summary:args.prompt,continuationPolicy:"wake_assignee",payload:{version:1,prompt:args.prompt,...args.payload}} as never,{agentId:f.agentId,runId:f.runId})).rejects.toThrow("standard-mode business document");
      expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId,f.issueId))).toHaveLength(0);
    }
  });
  it("rejects another task's document before creating an unusable review", async () => {
    const {f,args}=await seed();
    await documentService(server.db).upsertIssueDocument({issueId:f.blockerId,key:"foreign-notes",title:"Other task notes",format:"markdown",body:"Synthetic same-company other-task document.",baseRevisionId:null,changeSummary:null,createdByAgentId:f.agentId,createdByRunId:null});
    const doc=(await documentService(server.db).getIssueDocumentByKey(f.blockerId,"foreign-notes"))!;
    await expect(issueThreadInteractionService(server.db).create({id:f.issueId,companyId:f.companyId},{kind:"request_confirmation",addresseeAgentId:args.addresseeAgentId,idempotencyKey:args.idempotencyKey,sourceRunId:f.runId,title:args.title,summary:args.prompt,continuationPolicy:"wake_assignee",payload:{version:1,prompt:args.prompt,target:{type:"issue_document",issueId:f.blockerId,key:doc.key,documentId:doc.id,revisionId:doc.latestRevisionId}}} as never,{agentId:f.agentId,runId:f.runId})).rejects.toThrow("standard-mode business document");
    expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId,f.issueId))).toHaveLength(0);
  });
  it("reuses a stable document-review key after a fresh authorized run", async () => {
    const {f,args,call}=await seed();const first=await call() as any;const nextRunId=randomUUID();
    await server.db.update(heartbeatRuns).set({status:"succeeded",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.runId));
    await server.db.insert(heartbeatRuns).values({id:nextRunId,companyId:f.companyId,agentId:f.agentId,status:"running",runtimeMode:"native",nativeIssueId:f.issueId,contextSnapshot:{issueId:f.issueId}});
    await server.db.update(issues).set({executionRunId:nextRunId}).where(eq(issues.id,f.issueId));
    const next=new PaperclipRunnerToolAuthority(server.db,{companyId:f.companyId,agentId:f.agentId,issueId:f.issueId,runId:nextRunId,apiUrl:f.apiUrl,storage:f.storage,apiToolsEnabled:true});
    const second=await next.execute({tool:"request_human_input",callId:randomUUID(),arguments:args}) as any;
    expect(second).toMatchObject({disposition:"duplicate",interaction:{id:first.interaction.id,sourceRunId:f.runId}});
    expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId,f.issueId))).toHaveLength(1);
    const events=await server.db.select().from(activityLog).where(eq(activityLog.companyId,f.companyId));
    expect(events.filter(x=>x.action==="issue.thread_interaction_created")).toHaveLength(1);
  });
  it("rechecks a reviewer paused after the initial read but before creation", async () => {
    const { f, reviewerId, args } = await seed();
    const original = server.db.transaction.bind(server.db);
    const racedDb = new Proxy(server.db, { get(target, key) {
      if (key === "transaction") return async (...parameters: Parameters<typeof original>) => {
        await server.db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewerId));
        return original(...parameters);
      };
      return Reflect.get(target, key, target);
    } });
    await expect(issueThreadInteractionService(racedDb).create(
      { id: f.issueId, companyId: f.companyId },
      { kind: "request_confirmation", addresseeAgentId: reviewerId, idempotencyKey: args.idempotencyKey,
        sourceRunId: f.runId, title: args.title, summary: args.prompt, continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: args.prompt, ...args.payload } } as never,
      { agentId: f.agentId, runId: f.runId },
    )).rejects.toThrow("invokable");
    expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toHaveLength(0);
  });
  it.each(["current", "historical"] as const)("keeps named QA pending after an unrelated %s human comment", async (path) => {
    const { f, args, call } = await seed();
    const named = await call({ ...args, payload: { ...args.payload, supersedeOnUserComment: true } }) as any;
    const [comment] = await server.db.insert(issueComments).values({
      companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "fixture-human",
      body: "An unrelated operational comment.", createdAt: new Date(Date.now() + 1000),
    }).returning();
    const service = issueThreadInteractionService(server.db);
    const expired = path === "current"
      ? await service.expireRequestConfirmationsSupersededByComment(
        { id: f.issueId, companyId: f.companyId }, comment, { userId: "fixture-human" })
      : await service.expireRequestConfirmationsSupersededByHistoricalComments({ id: f.issueId, companyId: f.companyId });
    expect(expired).toHaveLength(0);
    const [row] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, named.interaction.id));
    expect(row.status).toBe("pending");
  });
  it("keeps creation and decision escape hatches closed", () => {
    expect(runnerApiMutationRestriction("/api/issues/{id}/interactions")).not.toBeNull();
    expect(runnerApiMutationRestriction("/api/issues/{id}/interactions/{interactionId}/accept")).not.toBeNull();
  });
});
