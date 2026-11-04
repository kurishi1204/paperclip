import express from "express";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import request from "supertest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { releaseNativeRunCheckout } from "../services/native-runtime/native-run-checkout.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, documents, documentRevisions,
  heartbeatRuns, issueDocuments, issueThreadInteractions, issues, authUsers, companyMemberships } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { hasServerRecordedNonAssigneeWake, isCurrentPendingDocumentReviewWake, pendingDocumentReviewRetryProfile, pendingDocumentReviewProfileFields } from "../services/pending-document-review-wake.js";
import { heartbeatService } from "../services/heartbeat.js";
import { materializeNativeInteractionResponses } from "../services/native-runtime/native-interaction-bridge.js";
import { runningProcesses } from "../adapters/index.js";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getNativeDocumentReviewAssignment, isNativeDocumentReviewRun } from "../services/native-runtime/native-document-review-participant.js";
import { stageNativeRunnerWakeAttachments } from "../services/native-runtime/native-runner-file-handoff.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { resolveNativeFinalizerStatus } from "../services/native-runtime/native-run-finalizer.js";
import { nativeCompletionFeedback } from "../services/native-runtime/native-completion-feedback.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import type { PrpStructuredRunResult } from "../vendor/paperclip-runner/index.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async (_input?: unknown) => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Synthetic independent review dispatch.", provider: "test", model: "test-model",
})));
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn("Pending review DB tests unavailable: " + support.reason);
suite("pending independent document review through real dispatch", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("paperclip-pending-review-"); db = createDb(temp.connectionString); }, 20000);
  let heartbeat: ReturnType<typeof heartbeatService> | undefined;
  afterEach(async () => {
    await heartbeat?.drainActiveRunExecutions(); heartbeat = undefined;
    mockAdapterExecute.mockClear(); runningProcesses.clear();
    await db.transaction(async tx=>{
      await tx.execute(sql`set local client_min_messages = 'warning'`);
      await tx.execute(sql`truncate table ${companies} cascade`);
      await tx.delete(authUsers);
    });
  });
  afterAll(async () => { await temp?.cleanup(); });
  async function seed() {
    const companyId=randomUUID(), ownerId=randomUUID(), reviewerId=randomUUID(), issueId=randomUUID();
    const documentId=randomUUID(), revisionId=randomUUID(), interactionId=randomUUID(), runId=randomUUID();
    await db.insert(companies).values({ id:companyId, name:"Synthetic review company", issuePrefix:"Q"+companyId.slice(0,6), defaultResponsibleUserId:"owner" });
    for (const id of [ownerId,reviewerId]) await db.insert(agents).values({
      id,companyId,name:id===ownerId?"Owner":"Reviewer",role:"engineer",status:"idle",adapterType:"codex_local",
      adapterConfig:{},runtimeConfig:{heartbeat:{enabled:true,wakeOnDemand:true,maxConcurrentRuns:1}},permissions:{},
    });
    await db.insert(issues).values({ id:issueId,companyId,title:"Synthetic independent proposal",status:"blocked",priority:"medium",assigneeAgentId:ownerId });
    await db.insert(documents).values({ id:documentId,companyId,title:"Fixed proposal",format:"markdown",
      latestBody:"Synthetic proposal only",latestRevisionId:revisionId,latestRevisionNumber:1,createdByAgentId:ownerId,updatedByAgentId:ownerId });
    await db.insert(documentRevisions).values({ id:revisionId,companyId,documentId,revisionNumber:1,title:"Fixed proposal",
      format:"markdown",body:"Synthetic proposal only",createdByAgentId:ownerId });
    await db.insert(issueDocuments).values({ companyId,issueId,documentId,key:"fixed-proposal" });
    const target={ type:"issue_document" as const,issueId,documentId,key:"fixed-proposal",revisionId };
    await db.insert(issueThreadInteractions).values({ id:interactionId,companyId,issueId,kind:"request_confirmation",
      status:"pending",continuationPolicy:"none",requestedResolverPolicy:"not_creator",effectiveResolverPolicy:"not_creator",
      createdByAgentId:ownerId,addresseeAgentId:reviewerId,payload:{version:1,prompt:"Review this fixed synthetic proposal",target} });
    const context={ issueId,interactionId,interactionKind:"request_confirmation",source:"issue.interaction.created",wakeReason:"interaction_pending" };
    const wakeupRequestId=randomUUID();
    await db.insert(agentWakeupRequests).values({id:wakeupRequestId,companyId,agentId:reviewerId,runId,
      source:"automation",triggerDetail:"system",reason:"interaction_pending",status:"queued",
      requestedByActorType:"agent",requestedByActorId:ownerId,idempotencyKey:`interaction-pending:${interactionId}`,
      payload:{issueId,interactionId,interactionKind:"request_confirmation"}});
    await db.insert(heartbeatRuns).values({ id:runId,companyId,agentId:reviewerId,invocationSource:"automation",status:"queued",wakeupRequestId,contextSnapshot:context });
    const input={ companyId,issueId,agentId:reviewerId,runId,contextSnapshot:context };
    return { ...input,ownerId,reviewerId,documentId,revisionId,interactionId,target,wakeupRequestId };
  }
  async function nativeReviewFixture() {
    const x = await seed();
    await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId:x.companyId, runId:x.runId, expectedStatus:"queued", now:new Date() });
    await db.update(issues).set({ executionRunId:x.runId }).where(eq(issues.id,x.issueId));
    await db.update(heartbeatRuns).set({ status:"running", runtimeMode:"native", nativeIssueId:x.issueId }).where(eq(heartbeatRuns.id,x.runId));
    const responsibleUserId = randomUUID();
    await db.insert(authUsers).values({id:responsibleUserId,name:"Synthetic responsible owner",email:`${responsibleUserId}@example.test`,createdAt:new Date(),updatedAt:new Date()});
    await db.insert(companyMemberships).values({companyId:x.companyId,principalType:"user",principalId:responsibleUserId,membershipRole:"owner",status:"active"});
    await db.update(heartbeatRuns).set({responsibleUserId}).where(eq(heartbeatRuns.id,x.runId));
    await db.update(agents).set({adapterType:"paperclip_runner"}).where(eq(agents.id,x.reviewerId));
    const binding = { companyId:x.companyId, issueId:x.issueId, agentId:x.reviewerId, runId:x.runId,
      documentReviewInteractionId:x.interactionId, apiUrl:"http://synthetic.invalid" };
    return { ...x, responsibleUserId, binding, authority:new PaperclipRunnerToolAuthority(db,binding) };
  }
  it("carries one fixed native document review through staging, read, actual decision and finish", async () => {
    const x = await nativeReviewFixture(), workspaceRoot = await mkdtemp(path.join(tmpdir(),"paperclip-document-review-"));
    const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "synthetic-document-review-secret";
    try {
      const stage = await stageNativeRunnerWakeAttachments({ db, binding:{ ...x.binding, workspaceRoot, executionTargetKind:"local" } });
      expect(stage.attachments).toEqual([]); await stage.cleanup();
      expect(x.authority.definitions().map(tool=>tool.name).sort()).toEqual([
        "get_task_context","get_task_history","list_document_revisions","list_documents","read_document","resolve_review",
      ].sort());
      expect(await x.authority.execute({ tool:"get_task_context", callId:"context", arguments:{} }))
        .toMatchObject({ assignedReview:{ id:x.interactionId, status:"pending" }, activeTask:{ assigneeAgentId:x.ownerId } });
      expect(await x.authority.execute({ tool:"read_document", callId:"document", arguments:{key:"fixed-proposal"} }))
        .toMatchObject({ document:{ id:x.documentId, latestRevisionId:x.revisionId, body:"Synthetic proposal only" } });
      await expect(x.authority.execute({ tool:"write_document", callId:"write", arguments:{} })).rejects.toThrow("may only inspect");
      await expect(x.authority.execute({ tool:"read_document", callId:"other-document", arguments:{key:"other-proposal"} })).rejects.toThrow("Read only the fixed document");
      const report = { reportedWorkDisposition:"done" } as PrpStructuredRunResult;
      await expect(nativeCompletionFeedback(db,x.runId,report)).rejects.toThrow("Resolve your assigned document review");
      vi.stubGlobal("fetch",vi.fn(async (url: string, options: RequestInit) => {
        expect(url).toBe(`http://synthetic.invalid/api/issues/${x.issueId}/interactions/${x.interactionId}/accept`);
        expect(options.method).toBe("POST");
        // Keep the real JWT actor middleware, HTTP route authorization and
        // verdict transaction; only transport is redirected into this test app.
        const app = express(); app.use(express.json());
        app.use(actorMiddleware(db,{deploymentMode:"authenticated"}));
        app.use("/api",issueRoutes(db,createStorageService(createLocalDiskStorageProvider(path.join(workspaceRoot,"storage")))));
        app.use(errorHandler);
        const response = await request(app).post(new URL(url).pathname)
          .set(Object.fromEntries(new Headers(options.headers).entries()))
          .send(JSON.parse(String(options.body)));
        expect(response.status,JSON.stringify(response.body)).toBe(200);
        return new Response(JSON.stringify(response.body),{status:response.status});
      }));
      expect(await x.authority.execute({ tool:"resolve_review", callId:"verdict", arguments:{decision:"accept"} }))
        .toMatchObject({interactionId:x.interactionId,status:"accepted"});
      expect(await nativeCompletionFeedback(db,x.runId,report)).toContain("report cannot override");
      expect(await getNativeDocumentReviewAssignment(db,{...x.binding,allowResolved:true}))
        .toMatchObject({interaction:{status:"accepted",resolvedByRunId:x.runId,resolvedByAgentId:x.reviewerId}});
      const [task] = await db.select().from(issues).where(eq(issues.id,x.issueId));
      expect(task).toMatchObject({assigneeAgentId:x.ownerId,status:"blocked"});
      const { arbitrateNativeStatus } = await import("../services/native-runtime/status-arbiter.js");
      const assessment = { reportedDisposition:"done" } as Parameters<typeof arbitrateNativeStatus>[0]["assessment"];
      const decision = resolveNativeFinalizerStatus({ assessment, terminalState:"succeeded", workspaceFinalizeStatus:"succeeded", documentReviewOutcome:"resolved", agentId:x.reviewerId, priorIssueStatus:"blocked" });
      expect(decision).toMatchObject({statusAction:"preserve",toStatus:"blocked",reasonCode:"native_document_review_resolved",effects:[{kind:"release_checkout"}]});
    } finally {
      vi.unstubAllGlobals();
      if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
      await rm(workspaceRoot,{recursive:true,force:true});
    }
  });
  it.each(["wrong_receipt","lost_lock","stale_revision","wrong_addressee","stale_then_assigned","missing_role_marker","wrong_role_marker","malformed_role_marker"] as const)(
    "refuses %s across native staging and tool reads", async defect => {
      const x = await nativeReviewFixture();
      if (defect === "wrong_receipt") await db.update(agentWakeupRequests).set({requestedByActorId:x.reviewerId}).where(eq(agentWakeupRequests.id,x.wakeupRequestId));
      if (defect === "lost_lock") await db.update(issues).set({executionRunId:null}).where(eq(issues.id,x.issueId));
      if (defect === "stale_revision") await db.update(documents).set({latestRevisionId:randomUUID()}).where(eq(documents.id,x.documentId));
      if (defect === "wrong_addressee") await db.update(issueThreadInteractions).set({addresseeAgentId:x.ownerId}).where(eq(issueThreadInteractions.id,x.interactionId));
      if (defect === "stale_then_assigned") {
        await db.update(documents).set({latestRevisionId:randomUUID()}).where(eq(documents.id,x.documentId));
        await db.update(issues).set({assigneeAgentId:x.reviewerId}).where(eq(issues.id,x.issueId));
      }
      if (["missing_role_marker","wrong_role_marker","malformed_role_marker"].includes(defect)) {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,x.runId));
        const profile = run!.runnerProfileJson as Record<string,unknown>;
        const admission = {...profile.pendingDocumentReviewAdmission as Record<string,unknown>};
        if (defect === "missing_role_marker") delete admission.nonAssignee;
        else admission.nonAssignee = defect === "wrong_role_marker" ? false : "true";
        await db.update(heartbeatRuns).set({runnerProfileJson:{...profile,pendingDocumentReviewAdmission:admission}}).where(eq(heartbeatRuns.id,x.runId));
      }
      expect(await getNativeDocumentReviewAssignment(db,x.binding)).toBeNull();
      await expect(stageNativeRunnerWakeAttachments({db,binding:{...x.binding,workspaceRoot:"/unused-synthetic-workspace",executionTargetKind:"local"}}))
        .rejects.toThrow("paperclip_runner_attachment_staging_not_authorized");
      await expect(x.authority.execute({tool:"read_document",callId:"denied",arguments:{key:"fixed-proposal"}})).rejects.toThrow();
      const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id,x.interactionId));
      expect(card!.status).toBe("pending");
    });
  it.each(["profile_only","profile_and_context","profile_context_and_wakeup_ref"] as const)(
    "retains the receipt-bound review purpose when %s disappears and reviewer becomes assignee", async defect => {
      const x = await nativeReviewFixture();
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,x.runId));
      const profile = {...saved!.runnerProfileJson as Record<string,unknown>};
      delete profile.pendingDocumentReviewAdmission;
      await db.update(heartbeatRuns).set({runnerProfileJson:profile,
        ...(defect !== "profile_only" ? {contextSnapshot:{issueId:x.issueId}} : {}),
        ...(defect === "profile_context_and_wakeup_ref" ? {wakeupRequestId:null} : {}),
      }).where(eq(heartbeatRuns.id,x.runId));
      await db.update(issues).set({assigneeAgentId:x.reviewerId}).where(eq(issues.id,x.issueId));
      const [changed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,x.runId));
      expect(await isNativeDocumentReviewRun(db,{...changed!,runId:x.runId})).toBe(true);
      expect(await getNativeDocumentReviewAssignment(db,x.binding)).toBeNull();
      await expect(stageNativeRunnerWakeAttachments({db,binding:{...x.binding,workspaceRoot:"/unused-synthetic-workspace",executionTargetKind:"local"}}))
        .rejects.toThrow("paperclip_runner_attachment_staging_not_authorized");
      await expect(nativeCompletionFeedback(db,x.runId,{reportedWorkDisposition:"done"} as PrpStructuredRunResult))
        .rejects.toThrow("fixed document review is no longer available");
      const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id,x.interactionId));
      expect(card!.status).toBe("pending");
    });
  it.each(["original_worker","reviewer_becomes_worker"] as const)(
    "does not classify a normal resolved-confirmation continuation as a review (%s)", async scenario => {
      const x=await nativeReviewFixture(), runId=randomUUID(), wakeupRequestId=randomUUID();
      const agentId=scenario==="original_worker"?x.ownerId:x.reviewerId;
      await db.update(issueThreadInteractions).set({status:"accepted",resolvedByAgentId:x.reviewerId,resolvedByRunId:x.runId})
        .where(eq(issueThreadInteractions.id,x.interactionId));
      await db.insert(agentWakeupRequests).values({id:wakeupRequestId,companyId:x.companyId,agentId,runId,
        source:"automation",triggerDetail:"system",reason:"interaction_resolved",status:"queued",
        requestedByActorType:"system",idempotencyKey:`interaction-resolved:${x.interactionId}`,
        payload:{issueId:x.issueId,interactionId:x.interactionId}});
      await db.insert(heartbeatRuns).values({id:runId,companyId:x.companyId,agentId,invocationSource:"automation",status:"running",
        runtimeMode:"native",nativeIssueId:x.issueId,wakeupRequestId,contextSnapshot:{issueId:x.issueId,interactionId:x.interactionId}});
      const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));
      expect(await isNativeDocumentReviewRun(db,{...run!,runId})).toBe(false);
    });
  it.each(["request_confirmation","request_checkbox_confirmation"] as const)(
    "rejects a direct JWT HTTP verdict on another %s even without a document target", async kind => {
      const x = await nativeReviewFixture(), otherId=randomUUID();
      await db.insert(issueThreadInteractions).values({id:otherId,companyId:x.companyId,issueId:x.issueId,kind,
        status:"pending",continuationPolicy:"none",requestedResolverPolicy:"not_creator",effectiveResolverPolicy:"not_creator",
        createdByAgentId:x.ownerId,addresseeAgentId:x.reviewerId,
        payload:kind==="request_confirmation"?{version:1,prompt:"Another synthetic confirmation"}:
          {version:1,prompt:"Another synthetic checklist",options:[{id:"one",label:"Synthetic item"}]}});
      const previousSecret=process.env.PAPERCLIP_AGENT_JWT_SECRET;
      process.env.PAPERCLIP_AGENT_JWT_SECRET="synthetic-fixed-review-http-secret";
      const workspaceRoot=await mkdtemp(path.join(tmpdir(),"paperclip-review-http-fence-"));
      try {
        const token=createLocalAgentJwt(x.reviewerId,x.companyId,"paperclip_runner",x.runId,x.responsibleUserId);
        const app=express();app.use(express.json());app.use(actorMiddleware(db,{deploymentMode:"authenticated"}));
        app.use("/api",issueRoutes(db,createStorageService(createLocalDiskStorageProvider(path.join(workspaceRoot,"storage")))));
        app.use(errorHandler);
        const response=await request(app).post(`/api/issues/${x.issueId}/interactions/${otherId}/accept`)
          .set("Authorization",`Bearer ${token}`).set("X-Paperclip-Run-Id",x.runId).send({});
        expect(response.status,JSON.stringify(response.body)).toBe(409);
        expect(JSON.stringify(response.body)).toContain("fixed document review binding changed");
        const cards=await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId,x.issueId));
        expect(cards.every(card=>card.status==="pending")).toBe(true);
      } finally {
        if(previousSecret===undefined)delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
        else process.env.PAPERCLIP_AGENT_JWT_SECRET=previousSecret;
        await rm(workspaceRoot,{recursive:true,force:true});
      }
    });
  it.each(["withdraw","verdicts"] as const)(
    "denies other interaction effects at the common transactional write boundary (%s)", async operation => {
      const x=await nativeReviewFixture(),otherId=randomUUID();
      await db.insert(issueThreadInteractions).values({id:otherId,companyId:x.companyId,issueId:x.issueId,
        kind:operation==="withdraw"?"request_confirmation":"request_item_verdicts",status:"pending",continuationPolicy:"none",
        requestedResolverPolicy:"not_creator",effectiveResolverPolicy:"not_creator",
        createdByAgentId:operation==="withdraw"?x.reviewerId:x.ownerId,
        addresseeAgentId:operation==="withdraw"?x.ownerId:x.reviewerId,
        payload:operation==="withdraw"?{version:1,prompt:"Previously created synthetic card"}:
          {version:1,prompt:"Other synthetic item verdict",items:[{id:"one",label:"Synthetic item"}],verdicts:["approve","reject"]}});
      const previousSecret=process.env.PAPERCLIP_AGENT_JWT_SECRET;
      process.env.PAPERCLIP_AGENT_JWT_SECRET="synthetic-common-effect-http-secret";
      const workspaceRoot=await mkdtemp(path.join(tmpdir(),"paperclip-review-effects-"));
      try {
        const token=createLocalAgentJwt(x.reviewerId,x.companyId,"paperclip_runner",x.runId,x.responsibleUserId);
        const app=express();app.use(express.json());app.use(actorMiddleware(db,{deploymentMode:"authenticated"}));
        app.use("/api",issueRoutes(db,createStorageService(createLocalDiskStorageProvider(path.join(workspaceRoot,"storage")))));
        app.use(errorHandler);
        const response=await request(app).post(`/api/issues/${x.issueId}/interactions/${otherId}/${operation}`)
          .set("Authorization",`Bearer ${token}`).set("X-Paperclip-Run-Id",x.runId)
          .send(operation==="withdraw"?{reason:"Synthetic forbidden withdrawal"}:{verdicts:[{id:"one",verdict:"approve"}]});
        expect(response.status,JSON.stringify(response.body)).toBe(403);
        expect(JSON.stringify(response.body)).toContain("document-review run may only resolve its fixed review");
        const cards=await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId,x.issueId));
        expect(cards.every(card=>card.status==="pending")).toBe(true);
      } finally {
        if(previousSecret===undefined)delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
        else process.env.PAPERCLIP_AGENT_JWT_SECRET=previousSecret;
        await rm(workspaceRoot,{recursive:true,force:true});
      }
    });
  it.each(["none", "wake_assignee"] as const)("preserves existing %s verdict workflow and finishes the review only", async continuationPolicy => {
    const x = await nativeReviewFixture();
    await db.update(issues).set({status:"in_review"}).where(eq(issues.id,x.issueId));
    await db.update(issueThreadInteractions).set({continuationPolicy}).where(eq(issueThreadInteractions.id,x.interactionId));
    // Use the existing decision service. A verdict may apply its stored workflow;
    // the reviewer's final report cannot reinterpret that decision as worker completion.
    await issueThreadInteractionService(db).rejectInteraction(
      {id:x.issueId,companyId:x.companyId},x.interactionId,{reason:"Synthetic required changes"},
      {agentId:x.reviewerId,runId:x.runId});
    const [task] = await db.select().from(issues).where(eq(issues.id,x.issueId));
    expect(task).toMatchObject({status:continuationPolicy==="none"?"in_review":"todo",assigneeAgentId:x.ownerId});
    expect(await getNativeDocumentReviewAssignment(db,{...x.binding,allowResolved:true}))
      .toMatchObject({interaction:{status:"rejected",resolvedByRunId:x.runId}});
    expect(await nativeCompletionFeedback(db,x.runId,{reportedWorkDisposition:"done"} as PrpStructuredRunResult))
      .toContain("report cannot override");
    const decision = resolveNativeFinalizerStatus({assessment:{reportedDisposition:"done"} as Parameters<typeof resolveNativeFinalizerStatus>[0]["assessment"],
      terminalState:"succeeded",workspaceFinalizeStatus:"succeeded",documentReviewOutcome:"resolved",agentId:x.reviewerId,
      priorIssueStatus:task!.status as "todo"|"in_review"});
    expect(decision).toMatchObject({statusAction:"preserve",toStatus:task!.status,reasonCode:"native_document_review_resolved"});
  });
  it("keeps a human task owner when rejecting a continuing document confirmation", async () => {
    const x = await nativeReviewFixture();
    await db.update(issues).set({status:"in_review",assigneeAgentId:null,assigneeUserId:x.responsibleUserId}).where(eq(issues.id,x.issueId));
    await db.update(issueThreadInteractions).set({continuationPolicy:"wake_assignee"}).where(eq(issueThreadInteractions.id,x.interactionId));
    await issueThreadInteractionService(db).rejectInteraction({id:x.issueId,companyId:x.companyId},x.interactionId,
      {reason:"Synthetic required changes"},{agentId:x.reviewerId,runId:x.runId});
    const [task] = await db.select().from(issues).where(eq(issues.id,x.issueId));
    expect(task).toMatchObject({status:"todo",assigneeAgentId:null,assigneeUserId:x.responsibleUserId});
    expect(await getNativeDocumentReviewAssignment(db,{...x.binding,allowResolved:true}))
      .toMatchObject({interaction:{status:"rejected",resolvedByRunId:x.runId}});
  });
  it.each(["revision","receipt","saved_binding","removed_admission"] as const)("refuses a %s change inside the verdict transaction", async defect => {
    const x = await nativeReviewFixture();
    expect(await getNativeDocumentReviewAssignment(db,x.binding)).not.toBeNull();
    await expect(issueThreadInteractionService(db).acceptInteraction(
      {id:x.issueId,companyId:x.companyId,projectId:null,goalId:null},x.interactionId,{},
      {agentId:x.reviewerId,runId:x.runId},{beforeResolveInTransaction:async tx=>{
        if (defect === "revision") await tx.update(documents).set({latestRevisionId:randomUUID()}).where(eq(documents.id,x.documentId));
        if (defect === "receipt") await tx.update(agentWakeupRequests).set({requestedByActorId:x.reviewerId}).where(eq(agentWakeupRequests.id,x.wakeupRequestId));
        if (defect === "removed_admission") {
          const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,x.runId));
          const profile = {...run!.runnerProfileJson as Record<string,unknown>};
          delete profile.pendingDocumentReviewAdmission;
          await tx.update(heartbeatRuns).set({runnerProfileJson:profile}).where(eq(heartbeatRuns.id,x.runId));
        }
        if (defect === "saved_binding") {
          const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,x.runId));
          const profile = run!.runnerProfileJson as Record<string,unknown>;
          const admission = profile.pendingDocumentReviewAdmission as Record<string,unknown>;
          await tx.update(heartbeatRuns).set({runnerProfileJson:{...profile,pendingDocumentReviewAdmission:{...admission,binding:{...(admission.binding as Record<string,unknown>),revisionId:randomUUID()}}}}).where(eq(heartbeatRuns.id,x.runId));
        }
      }})).rejects.toThrow("fixed document review binding changed");
    const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id,x.interactionId));
    expect(card!.status).toBe("pending");
    expect(await getNativeDocumentReviewAssignment(db,x.binding)).not.toBeNull();
  });
  it.each(["same_run","successor","mixed"] as const)("releases only its own checkout fields (%s)", async ownership => {
    const x = await nativeReviewFixture(), successorId = randomUUID();
    await db.insert(heartbeatRuns).values({id:successorId,companyId:x.companyId,agentId:x.ownerId,invocationSource:"automation",status:"running"});
    const lockedAt = new Date("2026-01-01T00:00:00Z");
    await db.update(issues).set({executionRunId:ownership==="same_run"?x.runId:successorId,
      checkoutRunId:ownership==="successor"?successorId:x.runId,executionAgentNameKey:"successor-owner",executionLockedAt:lockedAt}).where(eq(issues.id,x.issueId));
    await releaseNativeRunCheckout(db,x.binding);
    const [task] = await db.select().from(issues).where(eq(issues.id,x.issueId));
    expect(task!.checkoutRunId).toBe(ownership==="successor"?successorId:null);
    expect(task!.executionRunId).toBe(ownership==="same_run"?null:successorId);
    expect(task!.executionAgentNameKey).toBe(ownership==="same_run"?null:"successor-owner");
    expect(task!.executionLockedAt).toEqual(ownership==="same_run"?null:lockedAt);
    expect(task!.assigneeAgentId).toBe(x.ownerId);
  });
  it.each(["wrong_resolver_run","wrong_resolver_agent","changed_revision"] as const)(
    "does not allow post-verdict finishing with %s", async defect => {
      const x = await nativeReviewFixture();
      const otherRunId = randomUUID();
      if (defect === "wrong_resolver_run") await db.insert(heartbeatRuns).values({id:otherRunId,companyId:x.companyId,agentId:x.reviewerId,invocationSource:"automation",status:"succeeded"});
      await db.update(issueThreadInteractions).set({status:"accepted",resolvedByRunId:defect==="wrong_resolver_run"?otherRunId:x.runId,
        resolvedByAgentId:defect==="wrong_resolver_agent"?x.ownerId:x.reviewerId}).where(eq(issueThreadInteractions.id,x.interactionId));
      if (defect === "changed_revision") await db.update(documents).set({latestRevisionId:randomUUID()}).where(eq(documents.id,x.documentId));
      expect(await getNativeDocumentReviewAssignment(db,{...x.binding,allowResolved:true})).toBeNull();
    });
  it("admits the current independent reviewer without changing task assignment and hands off to the provider", async () => {
    const x=await seed(), adapter=createPostgresRunDispatchAdapter(db);
    expect(await adapter.cancelStaleQueuedRun({companyId:x.companyId,runId:x.runId,expectedStatus:"queued",now:new Date()})).toMatchObject({outcome:"not_stale"});
    const [record]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,x.runId));
    expect(hasServerRecordedNonAssigneeWake(record!.runnerProfileJson)).toBe(true);
    expect(record!.runnerProfileJson).toMatchObject({ pendingDocumentReviewAdmission:{interactionId:x.interactionId} });
    // The existing serialized execution lock is still mandatory at the final handoff.
    await db.update(issues).set({executionRunId:x.runId}).where(eq(issues.id,x.issueId));
    await db.update(heartbeatRuns).set({status:"running"}).where(eq(heartbeatRuns.id,x.runId));
    let calls=0;
    const result=await adapter.dispatchResolvedInteractionIfCurrent({companyId:x.companyId,runId:x.runId,expectedStatus:"running",now:new Date(),dispatch:async()=>{calls++;return "synthetic-provider-result";}});
    expect(result.dispatched).toBe(true); expect(calls).toBe(1);
    if(result.dispatched) expect(await result.resultPromise).toBe("synthetic-provider-result");
    const [task]=await db.select().from(issues).where(eq(issues.id,x.issueId));
    expect(task!.assigneeAgentId).toBe(x.ownerId);
  });
  it.each(["resolved","wrong_addressee","human_only","stale_revision","self_authored","governed_action","wrong_company","wrong_issue","unlinked_document"] as const)(
    "refuses %s before any provider work", async defect => {
      const x=await seed(),adapter=createPostgresRunDispatchAdapter(db);
      if(defect==="resolved") await db.update(issueThreadInteractions).set({status:"accepted"}).where(eq(issueThreadInteractions.id,x.interactionId));
      if(defect==="wrong_addressee") await db.update(issueThreadInteractions).set({addresseeAgentId:x.ownerId}).where(eq(issueThreadInteractions.id,x.interactionId));
      if(defect==="human_only") await db.update(issueThreadInteractions).set({effectiveResolverPolicy:"human_only"}).where(eq(issueThreadInteractions.id,x.interactionId));
      if(defect==="stale_revision") await db.update(documents).set({latestRevisionId:randomUUID()}).where(eq(documents.id,x.documentId));
      if(defect==="self_authored") await db.update(documents).set({createdByAgentId:x.reviewerId,updatedByAgentId:x.reviewerId}).where(eq(documents.id,x.documentId));
      if(defect==="governed_action") await db.update(issueThreadInteractions).set({payload:{version:1,prompt:"Governed",target:x.target,toolAction:{version:1} as never}}).where(eq(issueThreadInteractions.id,x.interactionId));
      if(defect==="wrong_company") x.companyId=randomUUID();
      if(defect==="wrong_issue") x.issueId=randomUUID();
      if(defect==="unlinked_document") await db.delete(issueDocuments).where(eq(issueDocuments.documentId,x.documentId));
      expect(await isCurrentPendingDocumentReviewWake(db,x)).toBe(false);
      if(defect!=="wrong_company"&&defect!=="wrong_issue") {
        expect(await adapter.cancelStaleQueuedRun({companyId:x.companyId,runId:x.runId,expectedStatus:"queued",now:new Date()})).toMatchObject({outcome:"cancelled",errorCode:"issue_assignee_changed"});
        const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,x.runId));
        expect(run!.startedAt).toBeNull();
      }
    });
  it.each(["revision_changed","revision_and_card_changed","target_replaced","resolved_then_reassigned"] as const)("rechecks %s after admission and before provider dispatch",async defect=>{
    const x=await seed(),adapter=createPostgresRunDispatchAdapter(db);
    expect(await adapter.cancelStaleQueuedRun({companyId:x.companyId,runId:x.runId,expectedStatus:"queued",now:new Date()})).toMatchObject({outcome:"not_stale"});
    await db.update(heartbeatRuns).set({status:"running"}).where(eq(heartbeatRuns.id,x.runId));
    await db.update(issues).set({executionRunId:x.runId,...(defect==="resolved_then_reassigned"?{assigneeAgentId:x.reviewerId}:{})}).where(eq(issues.id,x.issueId));
    if(defect==="revision_changed" || defect==="revision_and_card_changed") {
      const revisionId=randomUUID();
      await db.update(documents).set({latestRevisionId:revisionId}).where(eq(documents.id,x.documentId));
      if(defect==="revision_and_card_changed") await db.update(issueThreadInteractions)
        .set({payload:{version:1,prompt:"Changed review",target:{...x.target,revisionId}}}).where(eq(issueThreadInteractions.id,x.interactionId));
    } else if(defect==="target_replaced") {
      const documentId=randomUUID(),revisionId=randomUUID();
      await db.insert(documents).values({id:documentId,companyId:x.companyId,title:"Other synthetic document",format:"markdown",
        latestBody:"Other synthetic text",latestRevisionId:revisionId,latestRevisionNumber:1,createdByAgentId:x.ownerId,updatedByAgentId:x.ownerId});
      await db.insert(documentRevisions).values({id:revisionId,companyId:x.companyId,documentId,revisionNumber:1,title:"Other synthetic document",format:"markdown",body:"Other synthetic text",createdByAgentId:x.ownerId});
      await db.insert(issueDocuments).values({companyId:x.companyId,issueId:x.issueId,documentId,key:"other-proposal"});
      await db.update(issueThreadInteractions).set({payload:{version:1,prompt:"Retargeted review",target:{...x.target,key:"other-proposal",documentId,revisionId}}}).where(eq(issueThreadInteractions.id,x.interactionId));
    } else await db.update(issueThreadInteractions).set({status:"accepted"}).where(eq(issueThreadInteractions.id,x.interactionId));
    let calls=0;
    expect(await adapter.dispatchResolvedInteractionIfCurrent({companyId:x.companyId,runId:x.runId,expectedStatus:"running",now:new Date(),dispatch:async()=>{calls++;}}))
      .toMatchObject({dispatched:false,cancellation:{outcome:"cancelled",errorCode:"interaction_review_stale"}});
    expect(calls).toBe(0);
  });
  it("does not let the reviewer bypass the actual task execution lock",async()=>{
    const x=await seed(),adapter=createPostgresRunDispatchAdapter(db);
    expect(await adapter.cancelStaleQueuedRun({companyId:x.companyId,runId:x.runId,expectedStatus:"queued",now:new Date()})).toMatchObject({outcome:"not_stale"});
    await db.update(heartbeatRuns).set({status:"running"}).where(eq(heartbeatRuns.id,x.runId));
    let calls=0;
    expect(await adapter.dispatchResolvedInteractionIfCurrent({companyId:x.companyId,runId:x.runId,expectedStatus:"running",now:new Date(),dispatch:async()=>{calls++;}}))
      .toMatchObject({dispatched:false,cancellation:{outcome:"cancelled",errorCode:"issue_execution_lock_changed"}});
    expect(calls).toBe(0);
  });
  it.each(["missing_receipt","wrong_run","wrong_card","wrong_creator","settled_receipt"] as const)(
    "refuses a borrowed interaction ID with %s before provider work",async defect=>{
      const x=await seed();
      if(defect==="missing_receipt") await db.update(heartbeatRuns).set({wakeupRequestId:null}).where(eq(heartbeatRuns.id,x.runId));
      if(defect==="wrong_run") await db.update(agentWakeupRequests).set({runId:randomUUID()}).where(eq(agentWakeupRequests.id,x.wakeupRequestId));
      if(defect==="wrong_card") await db.update(agentWakeupRequests).set({payload:{issueId:x.issueId,interactionId:randomUUID(),interactionKind:"request_confirmation"}}).where(eq(agentWakeupRequests.id,x.wakeupRequestId));
      if(defect==="wrong_creator") await db.update(agentWakeupRequests).set({requestedByActorId:x.reviewerId}).where(eq(agentWakeupRequests.id,x.wakeupRequestId));
      if(defect==="settled_receipt") await db.update(agentWakeupRequests).set({status:"skipped"}).where(eq(agentWakeupRequests.id,x.wakeupRequestId));
      expect(await isCurrentPendingDocumentReviewWake(db,x)).toBe(false);
      expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({companyId:x.companyId,runId:x.runId,expectedStatus:"queued",now:new Date()}))
        .toMatchObject({outcome:"cancelled",errorCode:"issue_assignee_changed"});
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    });
  it("keeps a receipt-bound pending document review out of resolved response inputs", async () => {
    const x = await seed();
    await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId:x.companyId, runId:x.runId, expectedStatus:"queued", now:new Date() });
    await expect(materializeNativeInteractionResponses({ db, companyId:x.companyId, issueId:x.issueId,
      runId:x.runId, agentId:x.reviewerId, interactionIds:[x.interactionId] })).resolves.toEqual([]);
    const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id,x.interactionId));
    expect(card).toMatchObject({ status:"pending", result:null, resolvedByAgentId:null, resolvedByUserId:null });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,x.runId));
    expect(run!.runnerProfileJson).toMatchObject({ pendingDocumentReviewAdmission:{ interactionId:x.interactionId } });
  });
  it.each(["wrong_receipt", "stale_revision", "wrong_addressee"] as const)("still refuses %s instead of dropping an unresolved input", async defect => {
    const x = await seed();
    await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId:x.companyId, runId:x.runId, expectedStatus:"queued", now:new Date() });
    if (defect === "wrong_receipt") await db.update(agentWakeupRequests).set({ requestedByActorId:x.reviewerId }).where(eq(agentWakeupRequests.id,x.wakeupRequestId));
    if (defect === "stale_revision") await db.update(documents).set({ latestRevisionId:randomUUID() }).where(eq(documents.id,x.documentId));
    if (defect === "wrong_addressee") await db.update(issueThreadInteractions).set({ addresseeAgentId:x.ownerId }).where(eq(issueThreadInteractions.id,x.interactionId));
    await expect(materializeNativeInteractionResponses({ db, companyId:x.companyId, issueId:x.issueId,
      runId:x.runId, agentId:x.reviewerId, interactionIds:[x.interactionId] })).rejects.toMatchObject({ code:"native_interaction_unresolved" });
  });
  it("does not hide a missing response beside a valid pending review request", async () => {
    const x = await seed();
    await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId:x.companyId, runId:x.runId, expectedStatus:"queued", now:new Date() });
    await expect(materializeNativeInteractionResponses({ db, companyId:x.companyId, issueId:x.issueId,
      runId:x.runId, agentId:x.reviewerId, interactionIds:[x.interactionId,randomUUID()] })).rejects.toMatchObject({ code:"native_interaction_missing" });
  });
  it("creates the normal review wake, claims its execution lock, and reaches the adapter", async () => {
    const x=await seed();
    // Exercise the same wake options as the route, rather than a manually inserted Run.
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id,x.runId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id,x.wakeupRequestId));
    let observedRunId:string|undefined;
    heartbeat=heartbeatService(db,{runtimeEnv:{...process.env,PAPERCLIP_IN_WORKTREE:"false"},
      beforeResolvedInteractionContinuationDispatchCheck:async ({runId})=>{
        observedRunId=runId;
        const [task]=await db.select().from(issues).where(eq(issues.id,x.issueId));
        expect(task!.executionRunId).toBe(runId); expect(task!.assigneeAgentId).toBe(x.ownerId);
      }});
    const queued=await heartbeat.wakeup(x.reviewerId,{source:"automation",triggerDetail:"system",reason:"interaction_pending",
      payload:{issueId:x.issueId,interactionId:x.interactionId,interactionKind:"request_confirmation",mutation:"interaction"},
      idempotencyKey:`interaction-pending:${x.interactionId}`,requestedByActorType:"agent",requestedByActorId:x.ownerId,
      contextSnapshot:{...x.contextSnapshot,taskId:x.issueId}});
    expect(queued).not.toBeNull(); await heartbeat.drainActiveRunExecutions();
    const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,queued!.id));
    expect(run).toMatchObject({status:"succeeded",errorCode:null,
      runnerProfileJson:{pendingDocumentReviewAdmission:{interactionId:x.interactionId,binding:{documentId:x.documentId,revisionId:x.revisionId}}}});
    expect(observedRunId).toBe(queued!.id); expect(mockAdapterExecute).toHaveBeenCalledOnce();
    const [task]=await db.select().from(issues).where(eq(issues.id,x.issueId));
    expect(task!.assigneeAgentId).toBe(x.ownerId);
  });
  it("keeps a restored current queued review lock when the worker receives a separate wake", async () => {
    const x=await seed();
    await db.update(issues).set({executionRunId:x.runId}).where(eq(issues.id,x.issueId));
    heartbeat=heartbeatService(db,{runtimeEnv:{...process.env,PAPERCLIP_IN_WORKTREE:"false"}});
    await heartbeat.wakeup(x.ownerId,{source:"automation",reason:"issue_assigned",requestedByActorType:"system",
      contextSnapshot:{issueId:x.issueId},payload:{issueId:x.issueId}});
    const [review]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,x.runId));
    expect(review).toMatchObject({status:"queued",errorCode:null});
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });
  async function deferBeforeProvider(x:Awaited<ReturnType<typeof seed>>) {
    expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({companyId:x.companyId,runId:x.runId,expectedStatus:"queued",now:new Date()}))
      .toMatchObject({outcome:"not_stale"});
    await db.update(issues).set({executionRunId:x.runId}).where(eq(issues.id,x.issueId));
    await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date(),errorCode:"workspace_busy",
      resultJson:{executionRecovery:{kind:"workspace_wait",providerWorkStarted:false}},
      contextSnapshot:{...x.contextSnapshot,workspaceBusyDeferredWhileAssignee:false}}).where(eq(heartbeatRuns.id,x.runId));
    heartbeat=heartbeatService(db,{runtimeEnv:{...process.env,PAPERCLIP_IN_WORKTREE:"false"}});
    const result=await heartbeat.scheduleBoundedRetry(x.runId,{retryReason:"workspace_busy",wakeReason:"workspace_busy_retry",delayMs:0,maxAttempts:2});
    expect(result.outcome).toBe("scheduled");
    if(result.outcome!=="scheduled") throw new Error("Synthetic review did not schedule its resource wait");
    return result.run;
  }
  it("preserves the original review through real resource-wait scheduling, promotion and provider handoff",async()=>{
    const x=await seed(),retry=await deferBeforeProvider(x);
    expect(retry.runnerProfileJson).toMatchObject({pendingDocumentReviewAdmission:{interactionId:x.interactionId,
      origin:{runId:x.runId,wakeupRequestId:x.wakeupRequestId}}});
    expect(await isCurrentPendingDocumentReviewWake(db,{...x,runId:retry.id})).toBe(true);
    expect(await heartbeat!.promoteDueScheduledRetries(new Date(Date.now()+1000))).toMatchObject({promoted:1});
    await heartbeat!.resumeQueuedRuns(); await heartbeat!.drainActiveRunExecutions();
    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,retry.id));
    expect(run).toMatchObject({status:"succeeded",errorCode:null});
  });
  it.each(["changed_origin","changed_document","unknown_predecessor"] as const)("refuses a resource successor with %s",async defect=>{
    const x=await seed(),retry=await deferBeforeProvider(x);
    if(defect==="changed_origin") await db.update(heartbeatRuns).set({runnerProfileJson:{...retry.runnerProfileJson,
      pendingDocumentReviewAdmission:{...(retry.runnerProfileJson?.pendingDocumentReviewAdmission as Record<string,unknown>),
        origin:{runId:randomUUID(),wakeupRequestId:x.wakeupRequestId}}}}).where(eq(heartbeatRuns.id,retry.id));
    if(defect==="changed_document") await db.update(documents).set({latestRevisionId:randomUUID()}).where(eq(documents.id,x.documentId));
    if(defect==="unknown_predecessor") await db.update(heartbeatRuns).set({resultJson:{}}).where(eq(heartbeatRuns.id,x.runId));
    expect(await isCurrentPendingDocumentReviewWake(db,{...x,runId:retry.id})).toBe(false);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });
  it("copies only review authority, retaining no adapter preparation state",()=>{
    const admission={interactionId:"i",binding:{interactionId:"i"},origin:{runId:"r",wakeupRequestId:"w"},nonAssignee:true};
    expect(pendingDocumentReviewRetryProfile({pendingDocumentReviewAdmission:admission,adapterDispatch:{type:"old"},controllerBootId:"old"}))
      .toEqual({pendingDocumentReviewAdmission:admission});
    expect(pendingDocumentReviewRetryProfile({pendingDocumentReviewAdmission:{interactionId:"i"}})).toBeNull();
    expect(pendingDocumentReviewProfileFields({pendingDocumentReviewAdmission:null,adapterDispatch:{type:"old"}}))
      .toEqual({pendingDocumentReviewAdmission:null});
    expect(pendingDocumentReviewRetryProfile({adapterDispatch:{type:"normal"}})).toEqual({});
  });
  it("keeps server-recorded non-assignee authority from the prior version",()=>{
    expect(hasServerRecordedNonAssigneeWake({aiConnectionNonAssigneeCommentWake:true})).toBe(true);
    expect(hasServerRecordedNonAssigneeWake({wakeReason:"interaction_pending"})).toBe(false);
  });
});
