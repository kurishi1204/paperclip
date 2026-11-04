import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, documents, documentRevisions,
  heartbeatRuns, issueDocuments, issueThreadInteractions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { hasServerRecordedNonAssigneeWake, isCurrentPendingDocumentReviewWake, pendingDocumentReviewRetryProfile } from "../services/pending-document-review-wake.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";

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
  it("admits the current independent reviewer without changing task assignment and hands off to the provider", async () => {
    const x=await seed(), adapter=createPostgresRunDispatchAdapter(db);
    expect(await adapter.cancelStaleQueuedRun({companyId:x.companyId,runId:x.runId,expectedStatus:"queued",now:new Date()})).toMatchObject({outcome:"not_stale"});
    const [record]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,x.runId));
    expect(hasServerRecordedNonAssigneeWake(record!.runnerProfileJson)).toBe(true);
    expect(record!.runnerProfileJson).toMatchObject({ pendingDocumentReviewInteractionId:x.interactionId });
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
    expect(run).toMatchObject({status:"succeeded",errorCode:null});
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
    expect(retry.runnerProfileJson).toMatchObject({pendingDocumentReviewInteractionId:x.interactionId,
      pendingDocumentReviewOrigin:{runId:x.runId,wakeupRequestId:x.wakeupRequestId}});
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
      pendingDocumentReviewOrigin:{runId:randomUUID(),wakeupRequestId:x.wakeupRequestId}}}).where(eq(heartbeatRuns.id,retry.id));
    if(defect==="changed_document") await db.update(documents).set({latestRevisionId:randomUUID()}).where(eq(documents.id,x.documentId));
    if(defect==="unknown_predecessor") await db.update(heartbeatRuns).set({resultJson:{}}).where(eq(heartbeatRuns.id,x.runId));
    expect(await isCurrentPendingDocumentReviewWake(db,{...x,runId:retry.id})).toBe(false);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });
  it("copies only review authority, retaining no adapter preparation state",()=>{
    expect(pendingDocumentReviewRetryProfile({pendingDocumentReviewInteractionId:"i",pendingDocumentReviewBinding:{interactionId:"i"},
      pendingDocumentReviewOrigin:{runId:"r",wakeupRequestId:"w"},adapterDispatch:{type:"old"},controllerBootId:"old"}))
      .toEqual({aiConnectionNonAssigneeWake:false,pendingDocumentReviewInteractionId:"i",pendingDocumentReviewBinding:{interactionId:"i"},pendingDocumentReviewOrigin:{runId:"r",wakeupRequestId:"w"}});
    expect(pendingDocumentReviewRetryProfile({pendingDocumentReviewInteractionId:"i"})).toBeNull();
    expect(pendingDocumentReviewRetryProfile({adapterDispatch:{type:"normal"}})).toEqual({});
  });
  it("keeps server-recorded non-assignee authority from the prior version",()=>{
    expect(hasServerRecordedNonAssigneeWake({aiConnectionNonAssigneeCommentWake:true})).toBe(true);
    expect(hasServerRecordedNonAssigneeWake({wakeReason:"interaction_pending"})).toBe(false);
  });
});
