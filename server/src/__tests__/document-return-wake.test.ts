import {normalizePaperclipWakePayload,renderPaperclipWakePrompt} from "../../../packages/adapter-utils/src/server-utils.js";
import {executeDocumentReturn} from "../services/document-return-executor.js";
const effects=vi.hoisted(()=>({append:vi.fn(),pause:vi.fn(),blocker:vi.fn(),log:vi.fn()}));
vi.mock("../services/issues.js",()=>({issueService:()=>({addComment:effects.append})}));
vi.mock("../services/issue-tree-control.js",()=>({issueTreeControlService:()=>({getActivePauseHoldGate:effects.pause})}));
vi.mock("../services/execution-blocker.js",()=>({getExecutionBlocker:effects.blocker}));
vi.mock("../middleware/logger.js",()=>({logger:{warn:effects.log}}));
vi.mock("../services/activity-log.js",()=>({logActivity:vi.fn()}));
import {taskWatchdogService} from "../services/task-watchdogs.js";
import {describe,it,expect,vi} from "vitest";
import type {Db} from "@paperclipai/db";
import {collectDocumentReturnSupervision,readIssueDocumentReturnFollowthrough,prepareDocumentReturnWake,readCurrentDocumentReturnWake,readDocumentReturnPacket} from "../services/document-return-wake.js";
import {bindDocumentReturn,documentReturnBody,documentReturnKey,type DocumentReturnFacts} from "../services/document-return-contract.js";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function fixture(){
 const f:DocumentReturnFacts={issue:{id:id(2),companyId:id(1),assigneeAgentId:id(3),status:"blocked"},
  interaction:{id:id(5),companyId:id(1),issueId:id(2),kind:"request_confirmation",status:"accepted",continuationPolicy:"wake_assignee",
   createdByAgentId:id(3),addresseeAgentId:id(4),resolvedByAgentId:id(4),sourceRunId:id(6),resolvedByRunId:id(7),resolvedAt:"2026-11-15T08:18:05.826Z",
   payload:{version:1,target:{type:"issue_document",issueId:id(2),documentId:id(8),key:"report",revisionId:id(9),revisionNumber:1}},result:{version:1,outcome:"accepted"}},
  sourceRun:{id:id(6),companyId:id(1),agentId:id(3),issueId:id(2)},reviewRun:{id:id(7),companyId:id(1),agentId:id(4),issueId:id(2)},
  document:{companyId:id(1),issueId:id(2),id:id(8),key:"report",revisionId:id(9),latestRevisionId:id(9),revisionNumber:1,latestRevisionNumber:1,createdByAgentId:id(3),revisionAuthorId:id(3),body:"Synthetic fixed report"}};
 const b=bindDocumentReturn(f,id(3))!;
 const context={issueId:id(2),interactionId:id(5),sourceRunId:id(6),documentReturn:b};
 const run={id:id(10),companyId:id(1),agentId:id(3),status:"queued",runtimeMode:"legacy",nativeIssueId:null,retryOfRunId:null,wakeupRequestId:id(11),contextSnapshot:context};
 const wake={id:id(11),runId:id(10),companyId:id(1),agentId:id(3),status:"queued",requestedByActorType:"agent",requestedByActorId:id(4),idempotencyKey:`interaction:${id(5)}:accepted`,payload:{documentReturn:b}};
 const rows=()=>[[f.issue],[f.interaction],[{document:f.document,revision:{id:id(9),revisionNumber:1,createdByAgentId:id(3),body:f.document!.body},link:{issueId:id(2),key:"report"}}],
  [{...f.sourceRun,nativeIssueId:id(2)}],[{...f.reviewRun,nativeIssueId:id(2)}]];
 const input={companyId:id(1),issueId:id(2),agentId:id(3),interactionId:id(5),runId:id(10),contextSnapshot:context};
 return {f,b,context,run,wake,rows,input};
}
/** In-memory read port exercises the production adapter. It cannot connect,
 * mutate, launch a DB or send a wake; SQL/concurrency remain a separate gate. */
function port(rows:unknown[][]){
 let reads=0;const db={select(){const result=rows[reads++];if(!result)throw new Error("unexpected read");
  const q:any={from:()=>q,where:()=>q,innerJoin:()=>q,then:(ok:any,fail:any)=>Promise.resolve(result).then(ok,fail)};return q;}};
 return {db:db as unknown as Db,used:()=>reads};
}
describe("original return producer and reader over a nonDB port",()=>{
 it("produces a fixed binding but distinguishes stale and already recorded from unrelated continuation",async()=>{
  const x=fixture(),p=port([[x.f.interaction],...x.rows(),[]]);expect(await prepareDocumentReturnWake(p.db,x.input)).toEqual({kind:"ready",binding:x.b});expect(p.used()).toBe(7);
  x.f.document!.latestRevisionId=id(20);const stale=port([[x.f.interaction],...x.rows()]);expect(await prepareDocumentReturnWake(stale.db,x.input)).toMatchObject({kind:"held"});
  const y=fixture(),old=port([[y.f.interaction],...y.rows(),[{id:id(21)}]]);expect(await prepareDocumentReturnWake(old.db,y.input)).toEqual({kind:"held",reason:"resolution_wake_already_recorded"});
  const other=port([[{...y.f.interaction,payload:{target:{type:"issue"}}}]]);expect(await prepareDocumentReturnWake(other.db,y.input)).toEqual({kind:"not_applicable"});
 });
 it("keeps human and plan confirmations on their original continuation while holding stale named review",async()=>{
  const x=fixture();
  for(const card of [
   {...x.f.interaction,addresseeAgentId:null,addresseeUserId:"owner",resolvedByAgentId:null,resolvedByRunId:null},
   {...x.f.interaction,payload:{target:{...(x.f.interaction.payload as any).target,key:"plan"}}},
  ]) {
   const p=port([[card]]);expect(await prepareDocumentReturnWake(p.db,x.input)).toEqual({kind:"not_applicable"});expect(p.used()).toBe(1);
  }
  x.f.interaction.resolvedByAgentId=id(99);
  const stale=port([[x.f.interaction],...x.rows()]);
  expect(await prepareDocumentReturnWake(stale.db,x.input)).toMatchObject({kind:"held",reason:"fixed_document_binding_invalid"});
 });
 it("consumes the original queued shape then revalidates the native and exact stored ACK",async()=>{
  const x=fixture(),queued=port([...x.rows(),[x.run],[x.wake]]);
  expect(await readCurrentDocumentReturnWake(queued.db,{...x.input,phase:"claim"})).toEqual(x.b);
  const nonNative=port([...x.rows(),[x.run]]);expect(await readCurrentDocumentReturnWake(nonNative.db,x.input)).toBeNull();
  const run={...x.run,status:"running",runtimeMode:"native",nativeIssueId:id(2)};
  const first=port([...x.rows(),[run],[x.wake],[run]]);
  expect(await readDocumentReturnPacket(first.db,x.input)).toMatchObject({state:"ready",body:documentReturnBody(x.b),deliverableAllowed:false});
  const comment={id:id(12),companyId:id(1),issueId:id(2),authorAgentId:id(3),createdByRunId:id(10),body:documentReturnBody(x.b),deletedAt:null};
  const stored={...run,resultJson:{semanticToolReceipts:{[documentReturnKey(x.b)]:{operationId:"report_progress",result:{commentId:id(12),documentReturn:x.b,documentReturnAck:{commentId:id(12),binding:x.b}}}}}};
  const ack=port([...x.rows(),[stored],[x.wake],[stored],[comment]]);
  expect(await readDocumentReturnPacket(ack.db,x.input)).toEqual({state:"already_returned",commentId:id(12),maySend:false,companyAccepted:false,
    evaluation:{schema:"paperclip.document-return-evaluation.v1",eventKey:documentReturnKey(x.b),state:"company_receipt_unconfirmed",reason:null,
      evidence:{commentId:id(12),interactionId:x.b.interactionId,revisionId:x.b.revisionId,reviewerId:x.b.reviewerId,reviewRunId:x.b.reviewRunId,sourceRunId:x.b.sourceRunId},
      nextActorId:x.b.authorId,companyAccepted:false,knowledgeAdopted:false,recurrenceEffectiveness:"unverified",authorizesEffect:false}});
  const mismatch=port([...x.rows(),[stored],[x.wake],[stored],[{...comment,authorAgentId:id(20)}]]);
  expect(await readDocumentReturnPacket(mismatch.db,x.input)).toMatchObject({state:"rejected"});
 });
});

describe("bounded server executor through original read and write consumers without a database",()=>{
 it("saves and reads the exact real port row, atomically settles only the return and rejects a paused owner",async()=>{
  const x=fixture();const issue={...x.f.issue,executionRunId:id(10),checkoutRunId:null};
  const run={...x.run,status:"running",runnerProfileJson:{documentReturnAdmission:x.b},processPid:null,processGroupId:null,resultJson:{}};
  const comment={id:id(45),companyId:id(1),issueId:id(2),authorAgentId:id(3),createdByRunId:id(10),body:documentReturnBody(x.b),deletedAt:null};
  effects.pause.mockResolvedValue(null);effects.blocker.mockResolvedValue(null);effects.append.mockResolvedValue(comment);
  function transactionPort(paused=false){
    const rows=[[issue],[run],[{id:id(3),companyId:id(1),status:"active"}],...x.rows(),[run],[x.wake],...[...(paused?[]:[[run],[comment]])]];
    let read=0;const writes:any[]=[];
    const db:any={select(){const result=rows[read++];if(!result)throw new Error("unexpected read");const q:any={from:()=>q,where:()=>q,for:()=>q,innerJoin:()=>q,then:(ok:any,bad:any)=>Promise.resolve(result).then(ok,bad)};return q},
      update:()=>({set:(value:any)=>({where:()=>{writes.push(value);const result={...run,...value};return {
        returning:async()=>[result],then:(ok:any,bad:any)=>Promise.resolve(undefined).then(ok,bad)};}})}),
      transaction:async(fn:any)=>{try{return await fn(db)}catch(e){writes.length=0;throw e}}};
    return {db,writes,read:()=>read};
  }
  const p=transactionPort();const before=JSON.stringify(issue);
  expect(await executeDocumentReturn(p.db,x.input)).toMatchObject({disposition:"applied",commentId:id(45),companyAccepted:false});
  expect(effects.append).toHaveBeenCalledExactlyOnceWith(id(2),comment.body,{agentId:id(3),runId:id(10)},
    {authorizationReason:"fixed_document_return",mirrorToSlack:false},p.db);
  expect(p.writes).toHaveLength(2);expect(p.writes[1]).toMatchObject({status:"succeeded",issueCommentStatus:"satisfied",issueCommentSatisfiedByCommentId:id(45),issueCommentRetryQueuedAt:null});
  expect(p.writes[1].resultJson.semanticToolReceipts[documentReturnKey(x.b)].result.documentReturnAck.commentId).toBe(id(45));
  expect(JSON.stringify(issue)).toBe(before);expect(p.read()).toBe(12);
  effects.append.mockClear();effects.pause.mockResolvedValue({holdId:id(60)});
  const paused=transactionPort(true);await expect(executeDocumentReturn(paused.db,x.input)).rejects.toThrow("admission_revoked");
  expect(effects.append).not.toHaveBeenCalled();expect(paused.writes).toEqual([]);
 });
});

describe("existing supervisor followthrough read without replay authority",()=>{
 it("identifies missing handoff and an in-flight original run using the original adapter",async()=>{
  const x=fixture();
  const absent=port([[x.f.interaction],...x.rows(),[]]);
  const first=await readIssueDocumentReturnFollowthrough(absent.db,x.input);
  expect(first.events[0]).toMatchObject({eventKey:documentReturnKey(x.b),state:"held",reason:"no_original_return_admission",mayResend:false,authorizesEffect:false});
  const queued=port([[x.f.interaction],...x.rows(),[{...x.wake,runId:null}]]);
  expect((await readIssueDocumentReturnFollowthrough(queued.db,x.input)).events[0]).toMatchObject({state:"handoff_pending",wakeStatus:"queued",mayResend:false});
  const active=port([[x.f.interaction],...x.rows(),[x.wake],[x.run],[x.run]]);
  expect((await readIssueDocumentReturnFollowthrough(active.db,x.input)).events[0]).toMatchObject({state:"processing",runId:x.run.id,companyAccepted:false});
 });
 it("reads exact terminal ACK, keeps failed unknown and conflicting actor held",async()=>{
  const x=fixture();
  const comment={id:id(12),companyId:id(1),issueId:id(2),authorAgentId:id(3),createdByRunId:id(10),body:documentReturnBody(x.b),deletedAt:null};
  const stored={...x.run,status:"succeeded",resultJson:{semanticToolReceipts:{[documentReturnKey(x.b)]:{operationId:"report_progress",result:{commentId:comment.id,documentReturn:x.b,documentReturnAck:{commentId:comment.id,binding:x.b}}}}}};
  const rows=()=>[[x.f.interaction],...x.rows(),[{...x.wake,status:"completed"}],[stored],[stored],[comment]];
  const one=await readIssueDocumentReturnFollowthrough(port(rows()).db,x.input);
  const two=await readIssueDocumentReturnFollowthrough(port(rows()).db,x.input);
  const payload={taskWatchdog:{watchedIssueId:x.input.issueId,documentReturnFollowthrough:[one]}};
  expect(normalizePaperclipWakePayload(payload)?.taskWatchdog?.documentReturnFollowthrough).toMatchObject({state:"readable",issues:[{issueId:x.input.issueId,events:[{state:"effect_unconfirmed",eventKey:documentReturnKey(x.b)}]}]});
  expect(renderPaperclipWakePrompt(payload)).toContain(documentReturnKey(x.b));
  expect(renderPaperclipWakePrompt(payload)).toContain("never retry or admission authority");
  expect(normalizePaperclipWakePayload({taskWatchdog:{...payload.taskWatchdog,documentReturnFollowthrough:[{...one,authorizesEffect:true}]}})?.taskWatchdog?.documentReturnFollowthrough).toEqual({state:"invalid",issues:[]});
  const terminalNoRun=port([[x.f.interaction],...x.rows(),[{...x.wake,runId:null,status:"failed"}]]);
  expect((await readIssueDocumentReturnFollowthrough(terminalNoRun.db,x.input)).events[0]).toMatchObject({state:"held",reason:"terminal_or_unknown_wake_without_run"});
  expect(one).toEqual(two);expect(one.events[0]).toMatchObject({state:"effect_unconfirmed",evidenceSaved:true,mayResend:false,companyAccepted:false});
  const failed={...x.run,status:"failed"};
  const unknown=port([[x.f.interaction],...x.rows(),[{...x.wake,status:"completed"}],[failed],[failed]]);
  expect((await readIssueDocumentReturnFollowthrough(unknown.db,x.input)).events[0]).toMatchObject({state:"held",reason:"document_return_outcome_unknown"});
  const conflict=port([[x.f.interaction],...x.rows(),[{...x.wake,requestedByActorId:id(99)}]]);
  expect((await readIssueDocumentReturnFollowthrough(conflict.db,x.input)).events[0]).toMatchObject({state:"held",reason:"original_wake_binding_conflict"});
  const none=await readIssueDocumentReturnFollowthrough(port([[]]).db,x.input);
  expect(none).toMatchObject({events:[],absence:"no_matching_QA_event",stale:"not_configured",authorizesEffect:false});
 });
});

describe("configured watchdog read assessment before ordinary stop classification",()=>{
 it("detects a missing original handoff once per issue without granting a retry",async()=>{
  const x=fixture(),p=port([[x.f.interaction],...x.rows(),[]]);
  const r=await collectDocumentReturnSupervision(p.db,[x.input,x.input]);
  expect(r.observations).toHaveLength(1);expect(p.used()).toBe(7);
  expect(r).toMatchObject({attentionRequired:true,authorizesEffect:false,mayResend:false,stale:"not_configured",deadline:null});
  expect(r.observations[0].assessment!.events[0]).toMatchObject({state:"held",reason:"no_original_return_admission",eventKey:documentReturnKey(x.b)});
 });
 it("exposes changed revision, unavailable owner and failed read without claiming an empty healthy cycle",async()=>{
  const x=fixture();x.f.document!.latestRevisionId=id(90);
  const stale=await collectDocumentReturnSupervision(port([[x.f.interaction],...x.rows()]).db,[x.input]);
  expect(stale.observations[0].assessment!.events[0]).toMatchObject({state:"held",reason:"fixed_document_binding_invalid"});
  const bad=await collectDocumentReturnSupervision(port([]).db,[x.input,{companyId:id(1),issueId:id(20),agentId:null}]);
  expect(bad.observations.map(o=>o.state)).toEqual(["unreadable","owner_unavailable"]);expect(bad.attentionRequired).toBe(true);
  const empty=await collectDocumentReturnSupervision(port([]).db,[]);
  expect(empty.coverage).toBe("no_watched_issues");expect(empty.observations).toEqual([]);
 });
});

it("publishes the collected warning before a later original reconciliation failure, without swallowing failure",async()=>{
 const x=fixture();effects.log.mockClear();
 const wd={companyId:x.input.companyId,issueId:x.input.issueId,watchdogIssueId:null};
 const p=port([[wd],[x.f.interaction],...x.rows(),[]]);
 const db={...p.db,execute:async()=>[{...x.f.issue,assigneeAgentId:x.input.agentId}]} as unknown as Db;
 await expect(taskWatchdogService(db).reconcileTaskWatchdogs()).rejects.toThrow("unexpected read");
 expect(effects.log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({documentReturnSupervision:
  expect.objectContaining({attentionRequired:true,authorizesEffect:false,mayResend:false})}),
  "document-return supervision requires attention; read-only, no retry authority");
});
