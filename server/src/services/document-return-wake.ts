import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueThreadInteractions, issues, documents, documentRevisions, issueDocuments, issueComments, type Db } from "@paperclipai/db";
import { assessDocumentReturn, bindDocumentReturn, consumeDocumentReturn, documentReturnKey, sameDocumentReturn, type DocumentReturnBinding, type DocumentReturnDelivery, documentReturnRunMatches } from "./document-return-contract.js";
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string,unknown> : {};

/** Read-only adapter. Caller must hold the ordinary issue/run locks when admitting
 * or mutating. Nothing in a caller-supplied wake is accepted as server evidence. */
export async function readDocumentReturnBinding(db: Db, input: {
  companyId: string; issueId: string; agentId: string; interactionId: string;
}): Promise<DocumentReturnBinding | null> {
  if (!/^[0-9a-f-]{36}$/i.test(input.interactionId)) return null;
  const [issue] = await db.select().from(issues).where(and(eq(issues.id,input.issueId),eq(issues.companyId,input.companyId)));
  const [card] = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id,input.interactionId),
    eq(issueThreadInteractions.companyId,input.companyId),eq(issueThreadInteractions.issueId,input.issueId)));
  if (!issue || !card) return null;
  const target=object(object(card.payload).target);
  if (target.type !== "issue_document" || typeof target.key !== "string" || typeof target.revisionId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(target.revisionId) || !card.sourceRunId || !card.resolvedByRunId) return null;
  const readRun=async(id:string)=>{
    const [r]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,id),eq(heartbeatRuns.companyId,input.companyId)));
    return r ? {id:r.id,companyId:r.companyId,agentId:r.agentId,issueId:r.nativeIssueId ?? (typeof object(r.contextSnapshot).issueId === "string" ? object(r.contextSnapshot).issueId as string : null)} : null;
  };
  const [row]=await db.select({document:documents,revision:documentRevisions,link:issueDocuments})
    .from(issueDocuments).innerJoin(documents,eq(documents.id,issueDocuments.documentId))
    .innerJoin(documentRevisions,and(eq(documentRevisions.documentId,documents.id),eq(documentRevisions.id,target.revisionId)))
    .where(and(eq(issueDocuments.companyId,input.companyId),eq(issueDocuments.issueId,input.issueId),eq(issueDocuments.key,target.key),
      eq(documents.companyId,input.companyId),eq(documentRevisions.companyId,input.companyId)));
  const document=row ? {companyId:row.document.companyId,issueId:row.link.issueId,id:row.document.id,key:row.link.key,
    revisionId:row.revision.id,latestRevisionId:row.document.latestRevisionId,revisionNumber:row.revision.revisionNumber,
    latestRevisionNumber:row.document.latestRevisionNumber,createdByAgentId:row.document.createdByAgentId,
    revisionAuthorId:row.revision.createdByAgentId,body:row.revision.body} : null;
  return bindDocumentReturn({issue,interaction:card,sourceRun:await readRun(card.sourceRunId),reviewRun:await readRun(card.resolvedByRunId),document},input.agentId);
}

export function hasDocumentReturn(context: unknown): boolean {
  return Object.hasOwn(object(context),"documentReturn");
}

/** Producer only: do not backfill a settled/unknown original resolution wake. */
export async function prepareDocumentReturnWake(db: Db, input: Parameters<typeof readDocumentReturnBinding>[1]) {
  const [card]=await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id,input.interactionId),eq(issueThreadInteractions.companyId,input.companyId),eq(issueThreadInteractions.issueId,input.issueId)));
  if (!card) return {kind:"held" as const,reason:"interaction_missing"};
  const target=object(object(card.payload).target);
  // Match the original named-business-document review purpose, not every
  // document confirmation. Human/plan acceptance retains ordinary continuation.
  // Once a named review is selected, stale bindings remain held, never fallback.
  if (card.status !== "accepted" || card.kind !== "request_confirmation" ||
      !card.addresseeAgentId || card.addresseeUserId ||
      target.type !== "issue_document" || target.key === "plan") return {kind:"not_applicable" as const};
  const binding=await readDocumentReturnBinding(db,input);
  if (!binding) return {kind:"held" as const,reason:"fixed_document_binding_invalid"};
  const existing=await db.select({id:agentWakeupRequests.id}).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId,input.companyId),eq(agentWakeupRequests.agentId,input.agentId),
    eq(agentWakeupRequests.idempotencyKey,`interaction:${binding.interactionId}:accepted`)));
  return existing.length === 0 ? {kind:"ready" as const,binding} : {kind:"held" as const,reason:"resolution_wake_already_recorded"};
}

/** The exact saved resolution receipt, not a wake reason/comment placeholder,
 * establishes which fixed return is being consumed. Never admits retries. */
export async function readCurrentDocumentReturnWake(db: Db, input: {
  companyId:string; issueId:string; agentId:string; contextSnapshot:Record<string,unknown>;
  phase?:"claim"|"native"|"server"; runId?:string; request?:{ requestedByActorType:string|null; requestedByActorId:string|null; idempotencyKey:string|null; payload:unknown };
}): Promise<DocumentReturnBinding|null> {
  const expected=object(input.contextSnapshot.documentReturn);
  if (typeof expected.interactionId !== "string") return null;
  const b=await readDocumentReturnBinding(db,{...input,interactionId:expected.interactionId});
  if (!b || !sameDocumentReturn(expected,b) || input.contextSnapshot.interactionId !== b.interactionId ||
      input.contextSnapshot.sourceRunId !== b.sourceRunId || input.contextSnapshot.issueId !== b.issueId) return null;
  let request=input.request;
  if (input.runId) {
    const [run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,input.runId),
      eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,input.agentId)));
    if (!run || !run.wakeupRequestId || !documentReturnRunMatches(run,b,input.phase ?? "native")) return null;
    const [wake]=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id,run.wakeupRequestId),
      eq(agentWakeupRequests.companyId,input.companyId),eq(agentWakeupRequests.agentId,input.agentId),eq(agentWakeupRequests.runId,input.runId)));
    if (!wake || !["queued","claimed"].includes(wake.status)) return null;
    request=wake;
  }
  if (!request || request.requestedByActorType !== "agent" || request.requestedByActorId !== b.reviewerId ||
      request.idempotencyKey !== `interaction:${b.interactionId}:accepted` ||
      !sameDocumentReturn(object(request.payload).documentReturn,b)) return null;
  return b;
}

/** Read storage acknowledgment from the existing atomic semantic receipt and
 * real comment row. Missing/malformed outcome is unknown, never not_started. */
export async function readDocumentReturnDelivery(db:Db,b:DocumentReturnBinding,runId:string):Promise<DocumentReturnDelivery> {
  const [run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,runId),eq(heartbeatRuns.companyId,b.companyId),eq(heartbeatRuns.agentId,b.authorId)));
  if (!run || !sameDocumentReturn(object(run.contextSnapshot).documentReturn,b)) return {state:"unknown"};
  const receipts=object(object(run.resultJson).semanticToolReceipts),key=documentReturnKey(b);
  if (!Object.hasOwn(receipts,key)) return ["queued","running"].includes(run.status) ? {state:"not_started"} : {state:"unknown"};
  const receipt=object(receipts[key]),result=object(receipt.result),ack=object(result.documentReturnAck);
  if (receipt.operationId !== "report_progress" || typeof result.commentId !== "string" || !/^[0-9a-f-]{36}$/i.test(result.commentId)) return {state:"unknown"};
  const [comment]=await db.select().from(issueComments).where(and(eq(issueComments.id,result.commentId),eq(issueComments.companyId,b.companyId),eq(issueComments.issueId,b.issueId)));
  if (!comment || typeof ack.commentId !== "string") return {state:"unknown"};
  return {state:"committed",binding:result.documentReturn,runId,comment,acknowledgment:{commentId:ack.commentId,binding:ack.binding}};
}

export async function readDocumentReturnPacket(db:Db,input:Parameters<typeof readCurrentDocumentReturnWake>[1]) {
  const b=await readCurrentDocumentReturnWake(db,input);
  if (!b || !input.runId) return null;
  const facts={expected:input.contextSnapshot.documentReturn,current:b,
    delivery:await readDocumentReturnDelivery(db,b,input.runId)};
  return {...consumeDocumentReturn({...facts,operation:"return",dependenciesReady:false}),
    evaluation:assessDocumentReturn(facts)};
}

/** Supervisor/owner read model, never an admission or a recovery command.
 * Uses original accepted interactions and exact queue/terminal storage receipts;
 * no wake absence, elapsed time or stored projection can grant retry authority. */
export async function readIssueDocumentReturnFollowthrough(db:Db,input:{
  companyId:string;issueId:string;agentId:string;
}) {
  const cards=await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId,input.companyId),eq(issueThreadInteractions.issueId,input.issueId),
    eq(issueThreadInteractions.kind,"request_confirmation"),eq(issueThreadInteractions.status,"accepted")));
  const events=[];
  for(const card of cards) {
    const target=object(object(card.payload).target);
    if(target.type!=="issue_document" || target.key==="plan" || !card.addresseeAgentId || card.addresseeUserId) continue;
    const b=await readDocumentReturnBinding(db,{...input,interactionId:card.id});
    const base={interactionId:card.id,revisionId:typeof target.revisionId==="string"?target.revisionId:null,
      eventKey:b?documentReturnKey(b):null,nextActorId:b?b.authorId:null,
      authorizesEffect:false as const,mayResend:false as const,companyAccepted:false as const,
      knowledgeAdopted:false as const,effectiveness:"unverified" as const};
    if(!b){events.push({...base,state:"held",reason:"fixed_document_binding_invalid"});continue;}
    const wakes=await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId,b.companyId),eq(agentWakeupRequests.agentId,b.authorId),
      eq(agentWakeupRequests.idempotencyKey,`interaction:${b.interactionId}:accepted`)));
    if(wakes.length===0){events.push({...base,state:"held",reason:"no_original_return_admission"});continue;}
    const wake=wakes[0];
    if(wakes.length!==1 || wake.requestedByActorType!=="agent" || wake.requestedByActorId!==b.reviewerId ||
      !sameDocumentReturn(object(wake.payload).documentReturn,b)){
      events.push({...base,state:"held",reason:"original_wake_binding_conflict"});continue;
    }
    if(!wake.runId){
      const pending=["queued","deferred_issue_execution"].includes(wake.status);
      events.push({...base,wakeupId:wake.id,wakeStatus:wake.status,state:pending?"handoff_pending":"held",
        reason:pending?"recorded_wake_without_run":"terminal_or_unknown_wake_without_run"});continue;
    }
    const [run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,wake.runId),
      eq(heartbeatRuns.companyId,b.companyId),eq(heartbeatRuns.agentId,b.authorId)));
    if(!run || run.wakeupRequestId!==wake.id || run.retryOfRunId ||
      object(run.contextSnapshot).issueId!==b.issueId || !sameDocumentReturn(object(run.contextSnapshot).documentReturn,b)){
      events.push({...base,wakeupId:wake.id,state:"held",reason:"original_run_binding_conflict"});continue;
    }
    const delivery=await readDocumentReturnDelivery(db,b,run.id);
    const evaluated=assessDocumentReturn({expected:b,current:b,delivery});
    const saved=evaluated.state==="company_receipt_unconfirmed";
    const active=["queued","running"].includes(run.status) && ["queued","claimed"].includes(wake.status);
    events.push({...base,wakeupId:wake.id,runId:run.id,runStatus:run.status,wakeStatus:wake.status,
      state:saved?"effect_unconfirmed":active && delivery.state==="not_started"?"processing":"held",
      reason:saved?"exact_return_saved_company_ACK_not_bound":active && delivery.state==="not_started"?"original_run_active":evaluated.reason??"terminal_without_exact_return_receipt",
      evidenceSaved:saved,evaluation:evaluated});
  }
  return {schema:"paperclip.document-return-followthrough.v1" as const,companyId:input.companyId,issueId:input.issueId,
    events,coverage:"accepted_named_document_QA_only" as const,
    // No matching event is not proof of no business, approval or permissions.
    absence:events.length===0?"no_matching_QA_event" as const:null,
    deadline:null,stale:"not_configured" as const,authorizesEffect:false as const};
}

/** Periodic read-only assessment for the already configured watchdog scope.
 * Missing evidence is visible without requiring the ordinary stop classifier to
 * trigger a wake. This result neither schedules work nor acknowledges delivery.
 * Time-based staleness is deliberately unconfigured; binding is re-read now. */
export async function collectDocumentReturnSupervision(db:Db, targets: readonly {
  companyId:string;issueId:string;agentId:string|null;
}[]) {
  const observations: {
    companyId:string;issueId:string;state:"readable"|"unreadable"|"owner_unavailable";
    assessment?:Awaited<ReturnType<typeof readIssueDocumentReturnFollowthrough>>;
  }[]=[];
  const seen=new Set<string>();
  for(const target of targets) {
    const key=JSON.stringify([target.companyId,target.issueId]);
    if(seen.has(key)) continue;
    seen.add(key);
    if(!target.agentId) {
      observations.push({companyId:target.companyId,issueId:target.issueId,state:"owner_unavailable"});
      continue;
    }
    try {
      const assessment=await readIssueDocumentReturnFollowthrough(db,{...target,agentId:target.agentId});
      observations.push({companyId:target.companyId,issueId:target.issueId,state:"readable",assessment});
    } catch {
      // Do not leak DB diagnostics or misreport a failed read as zero events.
      observations.push({companyId:target.companyId,issueId:target.issueId,state:"unreadable"});
    }
  }
  return {schema:"paperclip.document-return-supervision.v1" as const,
    observations,attentionRequired:observations.some(o=>o.state!=="readable" ||
      o.assessment!.events.some(e=>e.state!=="processing")),
    coverage:observations.length===0?"no_watched_issues" as const:"configured_watchdog_scope_only" as const,
    deadline:null,stale:"not_configured" as const,authorizesEffect:false as const,mayResend:false as const};
}
