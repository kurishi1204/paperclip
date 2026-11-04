import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, documents, documentRevisions, heartbeatRunEvents,
  heartbeatRuns, issueDocuments, issueThreadInteractions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { hasServerRecordedNonAssigneeWake, isCurrentPendingDocumentReviewWake } from "../services/pending-document-review-wake.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn("Pending review DB tests unavailable: " + support.reason);
suite("pending independent document review through real dispatch", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("paperclip-pending-review-"); db = createDb(temp.connectionString); }, 20000);
  afterEach(async () => {
    await db.delete(activityLog); await db.delete(issueThreadInteractions); await db.delete(issueDocuments);
    await db.delete(documentRevisions); await db.delete(documents); await db.delete(issues);
    await db.delete(heartbeatRunEvents); await db.delete(heartbeatRuns); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => { await temp?.cleanup(); });
  async function seed() {
    const companyId=randomUUID(), ownerId=randomUUID(), reviewerId=randomUUID(), issueId=randomUUID();
    const documentId=randomUUID(), revisionId=randomUUID(), interactionId=randomUUID(), runId=randomUUID();
    await db.insert(companies).values({ id:companyId, name:"Synthetic review company", issuePrefix:"Q"+companyId.slice(0,6), defaultResponsibleUserId:"owner" });
    for (const id of [ownerId,reviewerId]) await db.insert(agents).values({
      id,companyId,name:id===ownerId?"Owner":"Reviewer",role:"engineer",status:"active",adapterType:"codex_local",
      adapterConfig:{},runtimeConfig:{heartbeat:{wakeOnDemand:true,maxConcurrentRuns:1}},permissions:{},
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
    await db.insert(heartbeatRuns).values({ id:runId,companyId,agentId:reviewerId,invocationSource:"automation",status:"queued",contextSnapshot:context });
    const input={ companyId,issueId,agentId:reviewerId,runId,contextSnapshot:context };
    return { ...input,ownerId,reviewerId,documentId,revisionId,interactionId,target };
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
  it.each(["revision_changed","resolved_then_reassigned"] as const)("rechecks %s after admission and before provider dispatch",async defect=>{
    const x=await seed(),adapter=createPostgresRunDispatchAdapter(db);
    expect(await adapter.cancelStaleQueuedRun({companyId:x.companyId,runId:x.runId,expectedStatus:"queued",now:new Date()})).toMatchObject({outcome:"not_stale"});
    await db.update(heartbeatRuns).set({status:"running"}).where(eq(heartbeatRuns.id,x.runId));
    await db.update(issues).set({executionRunId:x.runId,...(defect==="resolved_then_reassigned"?{assigneeAgentId:x.reviewerId}:{})}).where(eq(issues.id,x.issueId));
    if(defect==="revision_changed") await db.update(documents).set({latestRevisionId:randomUUID()}).where(eq(documents.id,x.documentId));
    else await db.update(issueThreadInteractions).set({status:"accepted"}).where(eq(issueThreadInteractions.id,x.interactionId));
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
  it("keeps server-recorded non-assignee authority from the prior version",()=>{
    expect(hasServerRecordedNonAssigneeWake({aiConnectionNonAssigneeCommentWake:true})).toBe(true);
    expect(hasServerRecordedNonAssigneeWake({wakeReason:"interaction_pending"})).toBe(false);
  });
});
