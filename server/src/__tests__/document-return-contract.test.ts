import {commitDocumentReturn,documentReturnGate,isDocumentReturnContext} from "../services/document-return-contract.js";
import { describe, expect, it } from "vitest";
import { bindDocumentReturn, consumeDocumentReturn, documentReturnBody, documentReturnKey, type DocumentReturnFacts, type DocumentReturnDelivery, documentReturnRunMatches } from "../services/document-return-contract.js";
import { allowsIssueInteractionWake } from "../modules/run-dispatch/domain/wake-context.js";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function facts():DocumentReturnFacts {
 const companyId=id(1),issueId=id(2),authorId=id(3),qaId=id(4);
 return {issue:{id:issueId,companyId,assigneeAgentId:authorId,status:"blocked"},
  interaction:{id:id(5),companyId,issueId,kind:"request_confirmation",status:"accepted",continuationPolicy:"wake_assignee",
   createdByAgentId:authorId,addresseeAgentId:qaId,resolvedByAgentId:qaId,sourceRunId:id(6),resolvedByRunId:id(7),
   resolvedAt:"2026-11-15T08:18:05.826Z",payload:{version:1,target:{type:"issue_document",issueId,documentId:id(8),key:"fixed-report",revisionId:id(9),revisionNumber:1}},result:{version:1,outcome:"accepted"}},
  sourceRun:{id:id(6),companyId,issueId,agentId:authorId},reviewRun:{id:id(7),companyId,issueId,agentId:qaId},
  document:{companyId,issueId,id:id(8),key:"fixed-report",revisionId:id(9),latestRevisionId:id(9),revisionNumber:1,latestRevisionNumber:1,
   createdByAgentId:authorId,revisionAuthorId:authorId,body:"Fixed synthetic report.\n日本語\n"}};
}
function ready(){const f=facts(),b=bindDocumentReturn(f,id(3))!;expect(b).not.toBeNull();return {f,b};}
describe("server-recorded fixed QA return",()=>{
 it("passes a fixed accepted QA target into the bounded return consumer while keeping deliverable blocked",()=>{
  const {b}=ready();const output=consumeDocumentReturn({expected:b,current:b,delivery:{state:"not_started"},operation:"return",dependenciesReady:false});
  expect(output).toMatchObject({state:"ready",deliverableAllowed:false,companyAccepted:false,dependenciesReady:false});
  expect(output).toHaveProperty("body",documentReturnBody(b));expect(output).toHaveProperty("idempotencyKey",documentReturnKey(b));
  expect(b.bodyBytes).toBe(Buffer.byteLength(facts().document!.body,"utf8"));
  expect(consumeDocumentReturn({expected:b,current:b,delivery:{state:"not_started"},operation:"deliverable",dependenciesReady:true})).toMatchObject({state:"rejected"});
 });
 it.each([
  ["company",(f:DocumentReturnFacts)=>{f.interaction.companyId=id(20)}],
  ["assignee",(f:DocumentReturnFacts)=>{f.issue.assigneeAgentId=id(20)}],
  ["creator",(f:DocumentReturnFacts)=>{f.interaction.createdByAgentId=id(20)}],
  ["source run",(f:DocumentReturnFacts)=>{f.sourceRun!.agentId=id(20)}],
  ["QA run",(f:DocumentReturnFacts)=>{f.reviewRun!.issueId=id(20)}],
  ["QA actor",(f:DocumentReturnFacts)=>{f.interaction.resolvedByAgentId=id(20)}],
  ["self QA",(f:DocumentReturnFacts)=>{f.interaction.addresseeAgentId=id(3);f.interaction.resolvedByAgentId=id(3)}],
  ["latest revision",(f:DocumentReturnFacts)=>{f.document!.latestRevisionId=id(20)}],
  ["revision author",(f:DocumentReturnFacts)=>{f.document!.revisionAuthorId=id(20)}],
  ["not accepted",(f:DocumentReturnFacts)=>{f.interaction.status="pending"}],
  ["withdrawn",(f:DocumentReturnFacts)=>{f.interaction.status="cancelled"}],
  ["no continuation",(f:DocumentReturnFacts)=>{f.interaction.continuationPolicy="none"}],
  ["missing source",(f:DocumentReturnFacts)=>{f.sourceRun=null}],
  ["invalid date",(f:DocumentReturnFacts)=>{f.interaction.resolvedAt="unknown"}],
 ] as const)("rejects changed %s",(_label,change)=>{const f=facts();change(f);expect(bindDocumentReturn(f,id(3))).toBeNull()});
 it("rejects substituted envelope, unknown effect and comment-based admission",()=>{
  const {b}=ready();
  expect(consumeDocumentReturn({expected:{...b,reviewerId:id(20)},current:b,delivery:{state:"not_started"},operation:"return",dependenciesReady:false}).state).toBe("rejected");
  expect(consumeDocumentReturn({expected:b,current:b,delivery:{state:"unknown"},operation:"return",dependenciesReady:false}).state).toBe("rejected");
  expect(allowsIssueInteractionWake({documentReturn:b,wakeReason:"issue_commented",wakeCommentId:id(20)},new Set(["issue_commented"]))).toBe(false);
 });
 it("requires the actual exact comment and ACK, never a fake ID or model assertion",()=>{
  const {b}=ready();const d:DocumentReturnDelivery={state:"committed",binding:b,runId:id(10),
   comment:{id:id(11),companyId:b.companyId,issueId:b.issueId,authorAgentId:b.authorId,createdByRunId:id(10),body:documentReturnBody(b),deletedAt:null},
   acknowledgment:{commentId:id(11),binding:b}};
  const consume=(delivery:DocumentReturnDelivery)=>consumeDocumentReturn({expected:b,current:b,delivery,operation:"return",dependenciesReady:false});
  expect(consume(d)).toEqual({state:"already_returned",commentId:id(11),maySend:false,companyAccepted:false});
  for(const changed of [ {...d,acknowledgment:{...d.acknowledgment,commentId:id(12)}},
   {...d,comment:{...d.comment,body:d.comment.body+" changed"}}, {...d,comment:{...d.comment,authorAgentId:id(12)}},
   {...d,comment:{...d.comment,deletedAt:"2026-11-15T09:00:00Z"}},
   {...d,acknowledgment:{...d.acknowledgment,binding:{...b,revisionId:id(12)}}}]) expect(consume(changed).state).toBe("rejected");
 });
});

describe("phase-specific saved run identity",()=>{
 it("accepts the original queued shape only at claim, and requires native binding at execution",()=>{
  const {b}=ready();const run={companyId:b.companyId,agentId:b.authorId,retryOfRunId:null,wakeupRequestId:id(12),
   runtimeMode:"legacy",status:"queued",nativeIssueId:null,contextSnapshot:{issueId:b.issueId,documentReturn:b}};
  expect(documentReturnRunMatches(run,b,"claim")).toBe(true);
  expect(documentReturnRunMatches(run,b,"native")).toBe(false);
  const native={...run,runtimeMode:"native",status:"running",nativeIssueId:b.issueId};
  expect(documentReturnRunMatches(native,b,"native")).toBe(true);
  expect(documentReturnRunMatches({...native,nativeIssueId:id(20)},b,"native")).toBe(false);
  expect(documentReturnRunMatches({...run,retryOfRunId:id(20)},b,"claim")).toBe(false);
  expect(documentReturnRunMatches({...run,status:"cancelled"},b,"claim")).toBe(false);
 });
});

describe("bounded server admission and original return commit consumer",()=>{
 it("keeps pause, ownership, cancellation and unknown holds independent of deliverable dependencies",()=>{
  const {b}=ready();const gate={binding:b,expected:b,ownerCurrent:true,paused:false,cancelled:false,unknownEffect:false};
  expect(documentReturnGate(gate)).toBe(true);
  for(const field of ["paused","cancelled","unknownEffect"] as const) expect(documentReturnGate({...gate,[field]:true})).toBe(false);
  expect(documentReturnGate({...gate,ownerCurrent:false})).toBe(false);
  expect(documentReturnGate({...gate,expected:{...b,revisionId:id(55)}})).toBe(false);
  expect(isDocumentReturnContext({documentReturn:null})).toBe(true);
  expect(isDocumentReturnContext({wakeReason:"document_return"})).toBe(false);
 });
 it("writes one exact comment and receipt then observes it without resending",async()=>{
  const {b}=ready();let delivery:DocumentReturnDelivery={state:"not_started"};let writes=0,saves=0;
  const comment={id:id(31),companyId:b.companyId,issueId:b.issueId,authorAgentId:b.authorId,createdByRunId:id(30),body:documentReturnBody(b),deletedAt:null};
  const port={binding:b,expected:b,runId:id(30),readDelivery:async()=>delivery,
    append:async(body:string)=>{expect(body).toBe(comment.body);writes++;return comment},
    saveReceipt:async(key:string,receipt:Record<string,unknown>)=>{saves++;expect(key).toBe(documentReturnKey(b));
      const r=receipt.result as any;delivery={state:"committed",binding:r.documentReturn,comment,runId:id(30),acknowledgment:r.documentReturnAck}}};
  expect(await commitDocumentReturn(port)).toMatchObject({disposition:"applied",companyAccepted:false});
  expect(await commitDocumentReturn(port)).toMatchObject({state:"already_returned",maySend:false});
  expect({writes,saves}).toEqual({writes:1,saves:1});
  delivery={state:"unknown"};await expect(commitDocumentReturn(port)).rejects.toThrow("outcome_unknown");
  expect({writes,saves}).toEqual({writes:1,saves:1});
 });
 it("does not acknowledge a changed persisted body/actor or issue an ordinary execution capability",async()=>{
  const {b}=ready();let saved=false;
  await expect(commitDocumentReturn({binding:b,expected:b,runId:id(30),readDelivery:async()=>({state:"not_started"}),
    append:async()=>({id:id(31),companyId:b.companyId,issueId:b.issueId,authorAgentId:id(55),createdByRunId:id(30),body:documentReturnBody(b),deletedAt:null}),
    saveReceipt:async()=>{saved=true}})).rejects.toThrow("storage_mismatch");expect(saved).toBe(false);
  const run={companyId:b.companyId,agentId:b.authorId,retryOfRunId:null,wakeupRequestId:id(12),runtimeMode:"legacy",status:"running",
    nativeIssueId:null,contextSnapshot:{issueId:b.issueId,documentReturn:b},runnerProfileJson:{documentReturnAdmission:b},processPid:null,processGroupId:null};
  expect(documentReturnRunMatches(run,b,"server")).toBe(true);
  expect(documentReturnRunMatches({...run,runnerProfileJson:{}},b,"server")).toBe(false);
  expect(documentReturnRunMatches({...run,processPid:123},b,"server")).toBe(false);
  expect(documentReturnRunMatches({...run,retryOfRunId:id(40)},b,"server")).toBe(false);
 });
});

it("does not promote the original plan confirmation into document return authority",()=>{const f=facts();(f.interaction.payload as any).target.key="plan";f.document!.key="plan";expect(bindDocumentReturn(f,id(3))).toBeNull();});
