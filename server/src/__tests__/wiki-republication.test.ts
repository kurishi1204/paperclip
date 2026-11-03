import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink } from "node:fs/promises";
import { join,relative } from "node:path";
import { tmpdir } from "node:os";
import { createPluginLocalFolderTextExclusive,resolvePluginLocalFolderPath } from "../services/plugin-local-folders.js";
import { executeRetraction,validateRetractionEvents,retractionEventHash,withRetractionMaintenanceLog,retainedRetractionFile,type RetractionEvent,type RetractionStore } from "../services/wiki-retraction-ledger.js";
import { retractionFolderGate,readRetractionFolderTextWithStatus,readRetractionFolderText } from "../services/wiki-retraction-gate.js";
import { assertCurrentWikiRepublication, assertWikiRepublicationTargetPath, wikiRepublicationRuntime } from "../services/wiki-republication-runtime.js";
import { appendRetractionMaintenanceLog } from "../services/wiki-retraction-store.js";
import { encodeWikiRepublicationDraft,resolveReviewedWikiRepublication,buildWikiRepublicationEvent,verifyCurrentWikiRepublication } from "../services/wiki-republication.js";
import { publicationCanonical,publicationHash,reviewBasis,verifyWikiPublication,type JsonObject,type PublicationRegistry } from "../services/wiki-publication-readback.js";

async function fixture() {
 const root=await realpath(await mkdtemp(join(tmpdir(),"wiki-republication-")));await mkdir(join(root,"wiki"));
 const events:RetractionEvent[]=[],pages:Record<string,{body:string;refs:JsonObject[]}>= {},docs:Record<string,any>={},reviews:Record<string,any>={};
 const registry:PublicationRegistry={schema:"colo.shared-wiki-publication-readback/v1",companyId:"c",wikiId:"default",spaceSlug:"default",qaAgentId:"qa",entries:[]};
 for(const name of ["p7","child","upstream"]){
  const path=`wiki/${name}.md`,body=`# ${name}\n\n${name==="child"?"Original mixed claim and independent fact":name==="p7"?"Withdrawn assumption":"Revalidated independent source"}\n`;
  const ref={kind:"document",issueId:name,documentId:"doc-"+name,documentKey:name,revisionId:"rev-"+name};
  const review={id:"qa-"+name,companyId:"c",issueId:name,status:"accepted",sourceRunId:"author-run",resolvedByAgentId:"qa",resolvedByRunId:"qa-run-"+name,resolvedAt:null,payload:{},result:{outcome:"accepted"}};
  const refs=[ref,...(name==="child"?[{kind:"document",issueId:"p7",documentId:"doc-p7",documentKey:"p7",revisionId:"rev-p7"}]:[])];
  pages[path]={body,refs};docs[name]={id:ref.documentId,companyId:"c",issueId:name,latestRevisionId:ref.revisionId,body,createdByAgentId:"author",updatedByAgentId:"author",updatedByUserId:null};reviews[review.id]=review;
  registry.entries.push({path,...ref,producerAgentId:"author",reviewId:review.id,wikiSHA256:publicationHash(body),documentBodySHA256:publicationHash(body),reviewRecordSHA256:publicationHash(publicationCanonical(reviewBasis(review))),sourceRefsSHA256:publicationHash(publicationCanonical(refs))});
  await writeFile(join(root,path),body);
 }
 await writeFile(join(root,"wiki/log.md"),"# 運用ログ\n\n保存済みの元記録。\n");
 const store:RetractionStore={read:async()=>events,transaction:async(_s,work)=>work({events:async()=>events,append:async e=>{events.push(e);}})};
 const target={companyId:"c",wikiId:"default",spaceSlug:"default",path:"wiki/p7.md",contentHash:publicationHash(pages["wiki/p7.md"]!.body)};
 await executeRetraction(store,{target,retractionId:"withdrawal",reason:"Revalidation required",actorId:"owner",runId:null,eventId:"withdrawal-event",at:"2026-11-03T10:00:00Z",
  approval:{id:"withdrawal-review",companyId:"c",target,reason:"Revalidation required",reviewerId:"qa",reviewRunId:"withdrawal-qa",ownerDecisionId:"real-human-decision"},
  fence:{folderKey:"wiki-root",rootPath:root,pathPrefix:"",mode:"citation-holds",blocks:[{path:target.path,contentHash:target.contentHash,state:"retracted"},{path:"wiki/child.md",contentHash:publicationHash(pages["wiki/child.md"]!.body),state:"blocked_by_retraction"},{path:"wiki/log.md",contentHash:publicationHash(await readFile(join(root,"wiki/log.md"))),state:"blocked_by_retraction"}],readable:[{path:"wiki/upstream.md",contentHash:publicationHash(pages["wiki/upstream.md"]!.body)}]},
  readCurrent:async()=>target});
 const newBody=encodeWikiRepublicationDraft({companyId:"c",wikiId:"default",spaceSlug:"default",retractionId:"withdrawal",previousPath:"wiki/child.md",path:"wiki/child-revalidated.md",reason:"Responsible author revalidated the unrelated claim",dependencies:[{path:"wiki/upstream.md",wikiSHA256:publicationHash(pages["wiki/upstream.md"]!.body)}]},"# Revised conclusion\n\nUse only the current independent source.\n");
 const doc={id:"new-doc",companyId:"c",issueId:"new-issue",latestRevisionId:"new-revision",latestBody:newBody,body:newBody,createdByAgentId:"author",updatedByAgentId:"author",updatedByUserId:null};docs["new-issue"]=doc;
 const review={id:"new-qa",companyId:"c",issueId:"new-issue",kind:"request_confirmation",status:"accepted",sourceRunId:"new-author-run",resolvedByAgentId:"qa",resolvedByRunId:"new-qa-run",resolvedAt:null,result:{outcome:"accepted"},payload:{target:{type:"issue_document",issueId:"new-issue",documentId:"new-doc",key:"revalidated",revisionId:"new-revision"}}};reviews[review.id]=review;
 const readers={page:async(p:string)=>{const {contents}=await readRetractionFolderTextWithStatus(root,p,retractionFolderGate(events,"c","wiki-root"));return {path:p,wikiId:"default",spaceSlug:"default",contents,hash:publicationHash(contents),sourceRefs:pages[p]!.refs};},document:async(issue:string)=>docs[issue]??null,review:async(_issue:string,id:string)=>reviews[id]?{...reviews[id],resolvedRun:{id:reviews[id].resolvedByRunId,companyId:"c",agentId:"qa",status:"succeeded"}}:null,retraction:async(p:string)=>retractionFolderGate(events,"c","wiki-root").block(p)};
 const input={companyId:"c",issueId:"new-issue",documentKey:"revalidated",actorId:"owner",document:doc,review,run:{id:"new-qa-run",companyId:"c",agentId:"qa",status:"succeeded"},registry,events,readers};
 return {root,events,pages,docs,reviews,registry,doc,review,input,readers,cleanup:()=>rm(root,{recursive:true})};
}
test("responsible author -> exact-version QA -> new immutable publication makes only the new version usable",async()=>{
 const f=await fixture();try{
  const oldBytes=await readFile(join(f.root,"wiki/child.md"));
  assert.equal((await verifyWikiPublication(f.registry,"wiki/child.md",f.readers)).state,"verified_with_citation_holds");
  const plan=await resolveReviewedWikiRepublication(f.input);
  assert.throws(()=>retractionFolderGate(f.events,"c","wiki-root").assertCitationRead(plan.draft.path),/E_SOURCE_RETRACTED/);
  const saved=await createPluginLocalFolderTextExclusive(f.root,plan.draft.path,plan.contents);assert.equal(saved.created,true);
  // Before the publication commit the new leaf stays unusable.
  await assert.rejects(readRetractionFolderTextWithStatus(f.root,plan.draft.path,retractionFolderGate(f.events,"c","wiki-root")),/E_SOURCE_RETRACTED/);
  const event=buildWikiRepublicationEvent(plan,{...f.input,operationId:"publish-op",eventId:"published",at:"2026-11-03T10:01:00Z"});f.events.push(event);
  f.pages[plan.draft.path]={body:plan.contents,refs:plan.sourceRefs};
  const bytes=await readRetractionFolderTextWithStatus(f.root,plan.draft.path,retractionFolderGate(f.events,"c","wiki-root"));
  assert.equal(bytes.contents,plan.contents);assert.deepEqual(bytes.citationHolds,[]);
  const proof=await verifyWikiPublication(plan.nextRegistry,plan.draft.path,f.readers);assert.equal(proof.state,"verified");assert.equal(proof.dependencies.length,1);
  assert.equal((await readRetractionFolderTextWithStatus(f.root,"wiki/child.md",retractionFolderGate(f.events,"c","wiki-root"))).citationHolds.length,1);
  await assert.rejects(readRetractionFolderTextWithStatus(f.root,"wiki/p7.md",retractionFolderGate(f.events,"c","wiki-root")),/E_SOURCE_RETRACTED/);
  assert.deepEqual(await readFile(join(f.root,"wiki/child.md")),oldBytes);
  assert.equal((await createPluginLocalFolderTextExclusive(f.root,plan.draft.path,"overwrite")).created,false);
  assert.equal(await readFile(join(f.root,plan.draft.path),"utf8"),plan.contents);
  assert.throws(()=>retractionFolderGate(f.events,"c","wiki-root").assertWrite(plan.draft.path),/WRITE_HOLD/);
 }finally{await f.cleanup();}
});
test("self QA, stale QA, different author, owner edits and forged original creator cannot release a hold",async()=>{
 const f=await fixture();try{
  const cases=[
   ()=>({...f.input,review:{...f.review,resolvedByAgentId:"author"}}),
   ()=>({...f.input,review:{...f.review,payload:{target:{...f.review.payload.target,revisionId:"old"}}}}),
   ()=>({...f.input,document:{...f.doc,createdByAgentId:"other"}}),
   ()=>({...f.input,document:{...f.doc,updatedByUserId:"owner"}}),
   ()=>({...f.input,run:{...f.input.run,status:"running"}}),
  ];for(const change of cases)await assert.rejects(resolveReviewedWikiRepublication(change()));
  f.docs.child.createdByAgentId="forged";await assert.rejects(resolveReviewedWikiRepublication(f.input),/original_creator/);
 }finally{await f.cleanup();}
});
test("a replacement that still cites withdrawn or held material remains blocked",async()=>{
 const f=await fixture();try{
  for(const path of ["wiki/p7.md","wiki/child.md"]){
   const text=encodeWikiRepublicationDraft({companyId:"c",wikiId:"default",spaceSlug:"default",retractionId:"withdrawal",previousPath:"wiki/child.md",path:"wiki/new.md",reason:"Recheck",dependencies:[{path,wikiSHA256:publicationHash(f.pages[path]!.body)}]},"# Candidate\n");
   await assert.rejects(resolveReviewedWikiRepublication({...f.input,document:{...f.doc,latestBody:text}}),/retracted|dependency_held/);
  }
 }finally{await f.cleanup();}
});
test("uncommitted orphan files never release a hold and existing names are never overwritten",async()=>{
 const f=await fixture();try{
  const plan=await resolveReviewedWikiRepublication(f.input);await createPluginLocalFolderTextExclusive(f.root,plan.draft.path,plan.contents);
  await assert.rejects(readRetractionFolderTextWithStatus(f.root,plan.draft.path,retractionFolderGate(f.events,"c","wiki-root")),/E_SOURCE_RETRACTED/);
  assert.equal((await createPluginLocalFolderTextExclusive(f.root,plan.draft.path,"changed")).created,false);
  assert.equal(f.events.length,1);assert.equal(await readFile(join(f.root,plan.draft.path),"utf8"),plan.contents);
 }finally{await f.cleanup();}
});
test("published receipt tampering and direct-source resurrection fail closed",async()=>{
 const f=await fixture();try{
  const plan=await resolveReviewedWikiRepublication(f.input);const e=buildWikiRepublicationEvent(plan,{...f.input,operationId:"op",eventId:"pub",at:"2026-11-03T10:01:00Z"});
  for(const mutate of [(x:RetractionEvent)=>{x.republication!.physicalPath="wiki/p7.md";},(x:RetractionEvent)=>{x.republication!.producerAgentId="qa";},(x:RetractionEvent)=>{x.approval.ownerDecisionId="fake-operation-uuid";}]){
   const v=structuredClone(e);mutate(v);const {eventHash:_hash,...basis}=v;v.eventHash=retractionEventHash(basis);assert.throws(()=>validateRetractionEvents(v,[...f.events,v]));
  }
 }finally{await f.cleanup();}
});
test("replacement bytes cannot change under a committed publication receipt",async()=>{
 const f=await fixture();try{
  const plan=await resolveReviewedWikiRepublication(f.input);await createPluginLocalFolderTextExclusive(f.root,plan.draft.path,plan.contents);
  f.events.push(buildWikiRepublicationEvent(plan,{...f.input,operationId:"op",eventId:"pub",at:"2026-11-03T10:01:00Z"}));
  await writeFile(join(f.root,plan.draft.path),"tampered");
  await assert.rejects(readRetractionFolderTextWithStatus(f.root,plan.draft.path,retractionFolderGate(f.events,"c","wiki-root")),/readable_content_changed/);
 }finally{await f.cleanup();}
});

test("entry-owned maintenance appends preserve exact original bytes and are idempotent after commit",async()=>{
 const f=await fixture();try{
  const file=join(f.root,"wiki/log.md"),original=await readFile(file);
  const withdrawal=withRetractionMaintenanceLog(f.events[0]!,[],original.toString("utf8"));f.events[0]=withdrawal;
  // The authoritative hold already exists even before the derived log append.
  await assert.rejects(readRetractionFolderTextWithStatus(f.root,"wiki/p7.md",retractionFolderGate(f.events,"c","wiki-root")),/E_SOURCE_RETRACTED/);
  assert.equal((await readRetractionFolderTextWithStatus(f.root,"wiki/log.md",retractionFolderGate(f.events,"c","wiki-root"))).contents,original.toString("utf8"));
  assert.equal((await appendRetractionMaintenanceLog(withdrawal,f.events)).alreadyPresent,false);
  const once=await readFile(file);assert.deepEqual(once.subarray(0,original.length),original);
  assert.equal((await appendRetractionMaintenanceLog(withdrawal,f.events)).alreadyPresent,true);
  assert.deepEqual(await readFile(file),once);
  const plan=await resolveReviewedWikiRepublication(f.input);
  const initial=buildWikiRepublicationEvent(plan,{...f.input,operationId:"op",eventId:"pub",at:"2026-11-03T10:01:00Z"});
  const publication=withRetractionMaintenanceLog(initial,f.events,once.toString("utf8"));f.events.push(publication);
  await appendRetractionMaintenanceLog(publication,f.events);
  const twice=await readFile(file,"utf8");assert.equal(twice.split("<!-- paperclip.wiki-maintenance/v1 -->").length-1,2);
  assert.equal(retainedRetractionFile(f.events,"wiki/log.md",withdrawal.fence!.blocks.at(-1)!.contentHash,twice),original.toString("utf8"));
  assert.equal((await readRetractionFolderTextWithStatus(f.root,"wiki/log.md",retractionFolderGate(f.events,"c","wiki-root"))).contents,twice);
 }finally{await f.cleanup();}
});
test("an earlier publication receipt stays appended after later maintenance events",async()=>{
 const f=await fixture();try{
  const file=join(f.root,"wiki/log.md"),original=await readFile(file,"utf8");
  const withdrawal=withRetractionMaintenanceLog(f.events[0]!,[],original);f.events[0]=withdrawal;
  await appendRetractionMaintenanceLog(withdrawal,f.events);
  const plan=await resolveReviewedWikiRepublication(f.input);
  const initial=buildWikiRepublicationEvent(plan,{...f.input,operationId:"history-op",eventId:"history-pub",at:"2026-11-03T10:01:00Z"});
  const publication=withRetractionMaintenanceLog(initial,f.events,await readFile(file,"utf8"));f.events.push(publication);
  await appendRetractionMaintenanceLog(publication,f.events);
  const tx={execute:async()=>[],transaction:async(work:(connection:unknown)=>Promise<unknown>)=>work(tx),
   select:(projection?:unknown)=>({from:()=>({where:async()=>projection?f.events.map(details=>({details})):
    [{details:{rootPath:f.root,path:plan.draft.path,contentHash:publication.contentHash}}]})})};
  // Exercise the actual receipt service over real files. Only SQL selection
  // and transaction transport are synthetic; this is not a DB qualification.
  const runtime=wikiRepublicationRuntime(tx as unknown as Parameters<typeof wikiRepublicationRuntime>[0],"synthetic-plugin");
  assert.equal((await runtime.receipt("c","history-op")).maintenanceLog.state,"appended");
  const {eventHash:_hash,maintenanceLog:_log,...basis}=withdrawal;
  const observationBasis={...basis,id:"later-observation",type:"observed" as const,sequence:3,previousHash:publication.eventHash,
   actorId:"independent-observer",runId:"observer-run",at:"2026-11-03T10:02:00Z"};
  const observation=withRetractionMaintenanceLog({...observationBasis,eventHash:retractionEventHash(observationBasis)},f.events,await readFile(file,"utf8"));
  f.events.push(observation);
  // A later pending append does not make the earlier successful append pending.
  assert.equal((await runtime.receipt("c","history-op")).maintenanceLog.state,"appended");
  await appendRetractionMaintenanceLog(observation,f.events);
  const complete=await readFile(file);
  assert.equal((await runtime.receipt("c","history-op")).maintenanceLog.state,"appended");
  assert.deepEqual(await readFile(file),complete);
  await writeFile(file,complete.subarray(0,complete.length-5));
  assert.equal((await runtime.receipt("c","history-op")).maintenanceLog.state,"unknown");
 }finally{await f.cleanup();}
});
test("a partial maintenance append is observed as unknown and is never automatically repeated",async()=>{
 const f=await fixture();try{
  const file=join(f.root,"wiki/log.md"),original=await readFile(file,"utf8");
  const event=withRetractionMaintenanceLog(f.events[0]!,[],original);f.events[0]=event;
  const partial=original+event.maintenanceLog!.appendText.slice(0,12);await writeFile(file,partial);
  await assert.rejects(appendRetractionMaintenanceLog(event,f.events),/maintenance_log_unknown_effect/);
  assert.equal(await readFile(file,"utf8"),partial);
  await assert.rejects(readRetractionFolderTextWithStatus(f.root,"wiki/log.md",retractionFolderGate(f.events,"c","wiki-root")),/maintenance_log_unknown_effect/);
  const forged=structuredClone(event);forged.maintenanceLog!.appendText+="forged";
  const {eventHash:_h,...basis}=forged;forged.eventHash=retractionEventHash(basis);
  assert.throws(()=>validateRetractionEvents(forged,[forged]),/maintenance_log_record/);
 }finally{await f.cleanup();}
});

test("unknown last editor never counts as the responsible author's revision",async()=>{
 const f=await fixture();try{
  await assert.rejects(resolveReviewedWikiRepublication({...f.input,document:{...f.doc,updatedByAgentId:null}}),/responsible_author/);
 }finally{await f.cleanup();}
});
test("new leaf alias planning compares the real existing ancestor before any file effect",async()=>{
 const f=await fixture();try{
  await mkdir(join(f.root,"other"));await symlink("../other",join(f.root,"wiki/alias"));
  const requested="wiki/alias/revalidated.md";
  const old=await resolvePluginLocalFolderPath(f.root,requested,{allowMissingLeaf:true});
  // The prior runtime's equality accepted this alias for a missing leaf.
  assert.equal(relative(f.root,old.realPath),requested);
  await assert.rejects(assertWikiRepublicationTargetPath(f.root,requested),/republication_alias/);
  await assertWikiRepublicationTargetPath(f.root,"wiki/new-parent/revalidated.md");
  await assert.rejects(readFile(join(f.root,"other/revalidated.md")),{code:"ENOENT"});
 }finally{await f.cleanup();}
});
test("both structured UI reads and ordinary reads reject a publication after its current QA is invalidated",async()=>{
 const f=await fixture();try{
  const plan=await resolveReviewedWikiRepublication(f.input);await createPluginLocalFolderTextExclusive(f.root,plan.draft.path,plan.contents);
  const event=buildWikiRepublicationEvent(plan,{...f.input,operationId:"op",eventId:"pub",at:"2026-11-03T10:01:00Z"});f.events.push(event);
  const current={event,registry:plan.nextRegistry,document:f.doc,review:f.review,run:f.input.run};
  const verify=async(p:string)=>{if(p===event.republication!.physicalPath)verifyCurrentWikiRepublication(current);};
  const gate=retractionFolderGate(f.events,"c","wiki-root");
  assert.equal((await readRetractionFolderTextWithStatus(f.root,plan.draft.path,gate,verify)).contents,plan.contents);
  f.review.status="rejected";
  // Reproduce the prior UI boundary: immutable bytes alone still look usable.
  assert.equal((await readRetractionFolderTextWithStatus(f.root,plan.draft.path,gate)).contents,plan.contents);
  await assert.rejects(readRetractionFolderTextWithStatus(f.root,plan.draft.path,gate,verify),/current_review/);
  await assert.rejects(readRetractionFolderText(f.root,plan.draft.path,gate,verify),/current_review/);
  assert.equal(await readRetractionFolderText(f.root,"wiki/upstream.md",gate,verify),f.pages["wiki/upstream.md"]!.body);
 }finally{await f.cleanup();}
});

test("changed space prefix cannot rebase a durable withdrawal onto another physical tree",async()=>{
 const f=await fixture();try{
  const row={status:"active",namespaceName:"plugin_synthetic",manifestJson:{database:{}},configJson:{publicationReadback:f.registry}};
  const tx={select:()=>({from:()=>({where:()=>({limit:async()=>[row],for:async()=>[row]})})}),
   execute:async()=>[{id:"space",path_prefix:"alternate",root_folder_key:"wiki-root",status:"active"}]};
  // The previous implementation returned before consulting any current space.
  await assert.rejects(assertCurrentWikiRepublication(tx as any,"plugin","c",f.events,"alternate/wiki/p7.md"),/current_space_binding/);
 }finally{await f.cleanup();}
});
test("removing an original held publication pin does not remove its current-QA requirement",async()=>{
 const f=await fixture();try{
  // The immutable event records which original paths were registered. This
  // fixture also covers a legacy event without that optional classification:
  // an unknown retained-body identity must not silently skip current QA.
  const pins={...f.registry,entries:f.registry.entries.filter(p=>p.path!=="wiki/child.md")};
  const row={status:"active",namespaceName:"plugin_synthetic",manifestJson:{database:{}},configJson:{publicationReadback:pins}};
  const tx={select:()=>({from:()=>({where:()=>({limit:async()=>[row],for:async()=>[row]})})}),
   execute:async()=>[{id:"space",path_prefix:"",root_folder_key:"wiki-root",status:"active"}]};
  await assert.rejects(assertCurrentWikiRepublication(tx as any,"plugin","c",f.events,"wiki/child.md"),/current_pin/);
 }finally{await f.cleanup();}
});

test("a body link cannot omit its exact declared dependency or revive a withdrawn source",async()=>{
 const f=await fixture();try{
  const base={companyId:"c",wikiId:"default",spaceSlug:"default",retractionId:"withdrawal",previousPath:"wiki/child.md",path:"wiki/child-revalidated.md",reason:"Responsible author checked the claim",dependencies:[]};
  for(const [target,reason]of [["wiki/upstream.md",/undeclared_body_reference/],["wiki/p7.md",/E_SOURCE_RETRACTED/]]as const){
   const body=encodeWikiRepublicationDraft(base,`# Revalidated\n\n[Evidence](${target})\n`);
   await assert.rejects(resolveReviewedWikiRepublication({...f.input,document:{...f.doc,latestBody:body}}),reason);
  }
 }finally{await f.cleanup();}
});
test("publication link indexing ignores machine lineage metadata and permits an explicit self link",async()=>{
 const f=await fixture();try{
  const draft={companyId:"c",wikiId:"default",spaceSlug:"default",retractionId:"withdrawal",previousPath:"wiki/child.md",path:"wiki/child-revalidated.md",reason:"Responsible author checked the claim",dependencies:[]};
  const body=encodeWikiRepublicationDraft(draft,"# Revalidated\n\n[This version](wiki/child-revalidated.md)\n");
  const plan=await resolveReviewedWikiRepublication({...f.input,document:{...f.doc,latestBody:body}});
  assert.deepEqual((plan as typeof plan&{backlinks:string[]}).backlinks,[draft.path]);
 }finally{await f.cleanup();}
});

for(const [name,body,reason]of [
 ["undeclared","See [[upstream|independent evidence]].",/undeclared_body_reference/],
 ["withdrawn","See [[p7#claim|old premise]].",/E_SOURCE_RETRACTED/],
]as const)test("rendered Wiki shorthand rejects "+name+" dependencies",async()=>{
 const f=await fixture();try{
  const draft=JSON.parse(f.doc.latestBody.split("\n")[1]!);draft.dependencies=[];
  const latestBody=encodeWikiRepublicationDraft(draft,body);
  await assert.rejects(resolveReviewedWikiRepublication({...f.input,document:{...f.doc,latestBody}}),reason);
 }finally{await f.cleanup();}
});
test("external URLs and code examples are not Wiki dependencies",async()=>{
 const f=await fixture();try{
  const draft=JSON.parse(f.doc.latestBody.split("\n")[1]!);draft.dependencies=[];
  const latestBody=encodeWikiRepublicationDraft(draft,"[site](https://example.test/wiki/p7.md)\n\nhttps://example.test/wiki/upstream.md\n\n`[[p7]]`\n\n```md\n[example](wiki/p7.md)\n```\n");
  const plan=await resolveReviewedWikiRepublication({...f.input,document:{...f.doc,latestBody}});
  assert.deepEqual(plan.backlinks,[]);
 }finally{await f.cleanup();}
});
test("Markdown reference-style links and Wiki shorthand share one canonical dependency",async()=>{
 const f=await fixture();try{
  const draft=JSON.parse(f.doc.latestBody.split("\n")[1]!);
  const latestBody=encodeWikiRepublicationDraft(draft,"[current][evidence] and [[upstream#scope|source]].\n\n[evidence]: upstream.md#scope\n");
  const plan=await resolveReviewedWikiRepublication({...f.input,document:{...f.doc,latestBody}});
  assert.deepEqual(plan.backlinks,["wiki/upstream.md"]);assert.equal(plan.sourceRefs.length,2);
 }finally{await f.cleanup();}
});
