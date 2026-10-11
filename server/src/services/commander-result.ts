import {createHash,randomUUID} from "node:crypto";
import {and,eq,sql} from "drizzle-orm";
import {agents,issues,heartbeatRuns,agentWakeupRequests,documents,documentRevisions,issueDocuments,type Db} from "@paperclipai/db";
import {conflict} from "../errors.js";
import {commanderAdmissionSchema,commanderAdmissionDigest,commanderPolicySchema,type CommanderAdmission} from "./commander-cycle.js";
import {applyIssueExecutionPolicyTransition,parseIssueExecutionState} from "./issue-execution-policy.js";
import {logActivity} from "./activity-log.js";
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
type Claim={issueId:string;commanderId:string;admission:CommanderAdmission;revision:number;statusVersion:number;parentRunId:string};
/** Server-owned provenance; no worker-authored configuration or callback command. */
export async function captureCommanderHermesClaim(db:Db,runId:string):Promise<Claim|null>{
 return db.transaction(async tx=>{
  const [r]=await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));
  if(!r)return null;
  const [w]=await tx.select().from(agents).where(eq(agents.id,r.agentId));
  const [wake]=await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,r.wakeupRequestId??randomUUID()));
  if(wake?.reason!=="commander_admitted_task"||wake.requestedByActorType!=="agent"||!wake.requestedByActorId)return null;
  const [c]=await tx.select().from(agents).where(and(eq(agents.id,wake.requestedByActorId),eq(agents.companyId,r.companyId)));
  const p=commanderPolicySchema.safeParse(c?.adapterConfig?.commanderCyclePolicy);
  const original=commanderAdmissionSchema.safeParse(r.contextSnapshot?.commanderAdmission);
  if(!p.success||c?.adapterConfig?.commanderCycleToolsOnly!==true||!original.success)throw conflict("Commander admission revoked before provider dispatch");
  const a=p.data.admissions.find(a=>wake.idempotencyKey===`commander-admission:${r.companyId}:${a.id}`);
  if(!a||commanderAdmissionDigest(a)!==commanderAdmissionDigest(original.data))throw conflict("Commander admission changed before provider dispatch");
  if(a.resultHandoff&&(w?.adapterType!=="hermes_local"||w.adapterConfig?.boundedExecution!==true))throw conflict("Commander result worker no longer uses the bounded Hermes adapter");
  const [i]=await tx.select().from(issues).where(and(eq(issues.id,a.issueId),eq(issues.companyId,r.companyId))).for("update");
  const [lockedRun]=await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId)).for("update");
  const [lockedCommander]=await tx.select().from(agents).where(eq(agents.id,c!.id)).for("update");
  if(lockedRun?.status!=="running"||JSON.stringify(lockedCommander?.adapterConfig)!==JSON.stringify(c?.adapterConfig))throw conflict("Commander claim changed concurrently");
  const parentRunId=String(r.contextSnapshot?.commanderRunId??"");
  if(r.status!=="running"||!i||i.status!=="in_progress"||i.statusVersion!==a.statusVersion+1||i.assigneeAgentId!==r.agentId||a.workerAgentId!==r.agentId||i.assigneeUserId||i.executionPolicy||i.executionState||hash(i.description??"")!==a.descriptionSha256||Date.parse(a.expiresAt)<=Date.now()||!parentRunId)throw conflict("Commander result claim changed before worker execution");
  if(!a.resultHandoff)return null;
  return {issueId:i.id,commanderId:c.id,admission:a,revision:i.revision,statusVersion:i.statusVersion,parentRunId};
 });
}
/** Atomic fixed artifact + independent review state. It never approves QA or owner acceptance. */
export async function completeCommanderHermesResult(db:Db,runId:string,claim:Claim,result:Record<string,unknown>){
 return db.transaction(async tx=>{
  const [i]=await tx.select().from(issues).where(eq(issues.id,claim.issueId)).for("update");
  const [r]=await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId)).for("update");
  const [c]=await tx.select().from(agents).where(eq(agents.id,claim.commanderId)).for("update");
  const p=commanderPolicySchema.safeParse(c?.adapterConfig?.commanderCyclePolicy),a=p.success?p.data.admissions.find(a=>a.id===claim.admission.id):null;
  const h=claim.admission.resultHandoff;
  const [parent]=await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,claim.parentRunId));
  const [q]=await tx.select().from(agents).where(eq(agents.id,h?.reviewerAgentId??randomUUID()));
  const text=result.result,urls=result.source_urls,searches=result.web_search_count;
  if(!i||!r||!h||r.status!=="running"||i.companyId!==r.companyId||i.status!=="in_progress"||i.revision!==claim.revision||i.statusVersion!==claim.statusVersion||i.assigneeAgentId!==r.agentId||i.assigneeUserId||i.executionPolicy||i.executionState||hash(i.description??"")!==claim.admission.descriptionSha256||!a||JSON.stringify(a)!==JSON.stringify(claim.admission)||c?.adapterConfig?.commanderCycleToolsOnly!==true||Date.parse(a.expiresAt)<=Date.now()||!parent||parent.agentId!==c.id||parent.companyId!==r.companyId||!["running","succeeded"].includes(parent.status)||!q||q.companyId!==r.companyId||q.id===r.agentId||q.adapterConfig?.qaReviewToolsOnly!==true||["paused","terminated"].includes(q.status)||typeof text!=="string"||!text.trim()||!Number.isInteger(searches)||Number(searches)<1||!Array.isArray(urls)||urls.length<1||urls.some(u=>typeof u!=="string"||!u.startsWith("https://")))throw conflict("Commander fixed result, current issue or independent QA authority changed");
  const existing=await tx.select().from(issueDocuments).where(and(eq(issueDocuments.issueId,i.id),eq(issueDocuments.key,h.documentKey)));if(existing.length)throw conflict("Commander result document already exists");
  const body="# Fixed commander-dispatched Hermes result\n\n"+JSON.stringify({runId,commanderRunId:parent.id,admissionId:a.id,reportSha256:hash(text),source_urls:urls,web_search_count:searches},null,2)+"\n\n"+text;
  const documentId=randomUUID(),revisionId=randomUUID();
  await tx.insert(documents).values({id:documentId,companyId:i.companyId,title:"Commander-dispatched Hermes result",format:"markdown",latestBody:body,latestRevisionId:revisionId,latestRevisionNumber:1,createdByAgentId:r.agentId,updatedByAgentId:r.agentId});
  await tx.insert(documentRevisions).values({id:revisionId,companyId:i.companyId,documentId,revisionNumber:1,body,createdByAgentId:r.agentId,createdByRunId:runId,changeSummary:"Fixed provider result; QA and owner acceptance pending"});
  await tx.insert(issueDocuments).values({companyId:i.companyId,issueId:i.id,documentId,key:h.documentKey});
  const policy={mode:"normal" as const,commentRequired:true,maxReviewRounds:2,stages:[{id:randomUUID(),type:"review" as const,approvalsNeeded:1 as const,participants:[{id:randomUUID(),type:"agent" as const,agentId:q.id,userId:null}]},{id:randomUUID(),type:"approval" as const,approvalsNeeded:1 as const,participants:[{id:randomUUID(),type:"user" as const,userId:h.ownerUserId,agentId:null}]}]};
  const transition=applyIssueExecutionPolicyTransition({issue:i,policy,previousPolicy:null,requestedStatus:"in_review",requestedAssigneePatch:{},actor:{agentId:null,userId:h.ownerUserId},allowBoardOverride:true,commentBody:"Server-owned exact Hermes result submitted for independent QA; human owner decision remains separate."});
  const [updated]=await tx.update(issues).set({...transition.patch,executionPolicy:policy,revision:i.revision+1,statusVersion:i.statusVersion+1,updatedAt:new Date()}).where(eq(issues.id,i.id)).returning();
  const state=parseIssueExecutionState(updated.executionState);if(state?.status!=="pending"||state.currentParticipant?.agentId!==q.id)throw conflict("Independent review did not become pending");
  const receipt={issueId:i.id,runId,documentId,documentKey:h.documentKey,documentRevisionId:revisionId,documentSha256:hash(body),reportSha256:hash(text),reviewStageId:state.currentStageId,reviewerAgentId:q.id,ownerUserId:h.ownerUserId,revision:updated.revision,statusVersion:updated.statusVersion};
  await tx.update(heartbeatRuns).set({resultJson:{...result,commanderHandoff:receipt},updatedAt:new Date()}).where(eq(heartbeatRuns.id,runId));
  await logActivity(tx as unknown as Db,{companyId:i.companyId,actorType:"system",actorId:"commander-result",runId,action:"issue.commander_result_submitted",entityType:"issue",entityId:i.id,details:receipt});
  return {receipt,issueId:i.id,reviewerAgentId:q.id,ownerUserId:h.ownerUserId,executionStage:{wakeRole:"reviewer",stageId:state.currentStageId,stageType:state.currentStageType,currentParticipant:state.currentParticipant,returnAssignee:state.returnAssignee,reviewRequest:state.reviewRequest??null,lastDecisionOutcome:state.lastDecisionOutcome,allowedActions:["approve","request_changes"]}};
 });
}

/** Durable retry uses the committed artifact/stage receipt, never another Hermes turn. */
export async function pendingCommanderResultHandoffs(db:Db){
 const rows=await db.select({run:heartbeatRuns,issue:issues}).from(heartbeatRuns).innerJoin(issues,sql`${issues.id}::text = ${heartbeatRuns.resultJson}->'commanderHandoff'->>'issueId'`).where(and(eq(issues.status,"in_review"),sql`${heartbeatRuns.resultJson}->'commanderHandoff' is not null`));
 const pending=[];
 for(const {run:r,issue:i} of rows){
  if(r.status==="cancelled")continue;
  const receipt=r.resultJson?.commanderHandoff as Record<string,unknown>|undefined,state=parseIssueExecutionState(i.executionState);
  if(!receipt||receipt.runId!==r.id||i.companyId!==r.companyId||i.revision!==receipt.revision||i.statusVersion!==receipt.statusVersion||state?.status!=="pending"||state.currentStageType!=="review"||state.currentStageId!==receipt.reviewStageId||state.currentParticipant?.agentId!==receipt.reviewerAgentId||i.assigneeAgentId!==receipt.reviewerAgentId)continue;
  const [d]=await db.select({document:documents,link:issueDocuments}).from(documents).innerJoin(issueDocuments,eq(issueDocuments.documentId,documents.id)).where(and(eq(documents.id,String(receipt.documentId)),eq(issueDocuments.issueId,i.id),eq(issueDocuments.key,String(receipt.documentKey))));
  if(!d||d.document.companyId!==r.companyId||d.document.latestRevisionId!==receipt.documentRevisionId||hash(d.document.latestBody)!==receipt.documentSha256)throw conflict("Durable commander result document changed before QA dispatch");
  pending.push({issueId:i.id,runId:r.id,reviewerAgentId:String(receipt.reviewerAgentId),ownerUserId:String(receipt.ownerUserId),revision:i.revision,statusVersion:i.statusVersion,executionStage:{wakeRole:"reviewer",stageId:state.currentStageId,stageType:state.currentStageType,currentParticipant:state.currentParticipant,returnAssignee:state.returnAssignee,reviewRequest:state.reviewRequest??null,lastDecisionOutcome:state.lastDecisionOutcome,allowedActions:["approve","request_changes"]}});
 }
 return pending;
}
