import { extractWikiLinks } from "@paperclipai/plugin-sdk";
import { publicationCanonical, publicationHash, publicationNeed, reviewBasis, verifyWikiPublication,
  type JsonObject, type PublicationPin, type PublicationReaders, type PublicationRegistry } from "./wiki-publication-readback.js";
import { retractionEventHash, validateRetractionEvents, type RetractionEvent, type RetractionScope } from "./wiki-retraction-ledger.js";

export interface WikiRepublicationDraft extends RetractionScope {
  retractionId: string; previousPath: string; path: string; reason: string;
  dependencies: Array<{ path: string; wikiSHA256: string }>;
}
const PREFIX = "<!-- paperclip.wiki-republication/v1\n";
const END = "\n-->\n\n";
export function encodeWikiRepublicationDraft(draft: WikiRepublicationDraft, body: string) {
  return PREFIX + JSON.stringify(draft) + END + body;
}
export function parseWikiRepublicationDraft(body: string): WikiRepublicationDraft {
  publicationNeed(body.startsWith(PREFIX), "republication_draft_header");
  const end = body.indexOf(END, PREFIX.length);
  publicationNeed(end > PREFIX.length && body.slice(end + END.length).trim(), "republication_draft_body");
  let value: unknown;
  try { value = JSON.parse(body.slice(PREFIX.length,end)); } catch { throw new Error("wiki_publication_republication_draft_json"); }
  publicationNeed(value && typeof value === "object" && !Array.isArray(value), "republication_draft_shape");
  const d=value as WikiRepublicationDraft;
  const keys=["companyId","wikiId","spaceSlug","retractionId","previousPath","path","reason","dependencies"].sort();
  publicationNeed(JSON.stringify(Object.keys(d).sort())===JSON.stringify(keys), "republication_draft_fields");
  for(const k of keys.filter(k=>k!=="dependencies")) publicationNeed(typeof d[k as keyof WikiRepublicationDraft]==="string" &&
    (d[k as keyof WikiRepublicationDraft] as string).trim()===(d[k as keyof WikiRepublicationDraft] as string) && d[k as keyof WikiRepublicationDraft], "republication_draft_field");
  for(const p of [d.path,d.previousPath]) publicationNeed(p.startsWith("wiki/")&&p.endsWith(".md")&&!p.includes("\\")&&
    p.split("/").every(s=>s&&s!=="."&&s!==".."),"republication_path");
  publicationNeed(d.path!==d.previousPath&&Array.isArray(d.dependencies),"republication_new_version");
  for(const ref of d.dependencies) publicationNeed(ref&&typeof ref==="object"&&
    JSON.stringify(Object.keys(ref).sort())===JSON.stringify(["path","wikiSHA256"])&&typeof ref.path==="string"&&/^[a-f0-9]{64}$/.test(ref.wikiSHA256),"republication_dependency");
  publicationNeed(new Set(d.dependencies.map(r=>r.path)).size===d.dependencies.length,"republication_duplicate_dependency");
  return d;
}
export interface RepublicationDocument { id:string;companyId:string;latestRevisionId:string|null;latestBody:string;
  createdByAgentId:string|null;updatedByAgentId:string|null;updatedByUserId?:string|null; }
export interface RepublicationReview { id:string;companyId:string;issueId:string;kind:string;status:string;result:unknown;payload:unknown;
  sourceRunId:string|null;resolvedByAgentId:string|null;resolvedByRunId:string|null; }
export async function resolveReviewedWikiRepublication(input:{
  companyId:string;issueId:string;documentKey:string;actorId:string;
  document:RepublicationDocument|null;review:RepublicationReview|null;
  run:{id:string;companyId:string;agentId:string;status:string}|null;
  registry:PublicationRegistry;events:RetractionEvent[];readers:PublicationReaders;
}) {
  const doc=input.document,review=input.review;
  publicationNeed(doc&&doc.companyId===input.companyId&&doc.latestRevisionId&&doc.createdByAgentId,"republication_document");
  const draft=parseWikiRepublicationDraft(doc.latestBody),registry=input.registry;
  publicationNeed(draft.companyId===input.companyId&&draft.wikiId===registry.wikiId&&draft.spaceSlug===registry.spaceSlug,"republication_scope");
  publicationNeed(typeof input.readers.retraction==="function","republication_host_retraction_reader");
  const events=validateRetractionEvents(draft,input.events);
  const parent=events.find(e=>e.type==="executed"&&e.retractionId===draft.retractionId);
  publicationNeed(parent?.fence?.mode==="citation-holds","republication_parent");
  const previousPhysical=(parent.fence.pathPrefix?parent.fence.pathPrefix+"/":"")+draft.previousPath;
  publicationNeed(parent.fence.blocks.some(b=>b.path===previousPhysical&&b.state==="blocked_by_retraction"),"republication_not_downstream");
  const old=registry.entries.find(p=>p.path===draft.previousPath);
  publicationNeed(old&&old.producerAgentId===doc.createdByAgentId&&doc.updatedByAgentId===doc.createdByAgentId&&
    !doc.updatedByUserId,"republication_responsible_author");
  const original=await input.readers.document(old.issueId,old.documentKey);
  publicationNeed(original?.id===old.documentId&&original.createdByAgentId===old.producerAgentId,"republication_original_creator");
  await verifyWikiPublication(registry,old.path,input.readers);
  const target=(review?.payload as {target?:JsonObject}|null)?.target;
  const qa=old.qaAgentId??registry.qaAgentId;
  publicationNeed(review&&review.companyId===input.companyId&&review.issueId===input.issueId&&review.kind==="request_confirmation"&&
    review.status==="accepted"&&(review.result as {outcome?:string}|null)?.outcome==="accepted"&&
    target?.type==="issue_document"&&target.issueId===input.issueId&&target.documentId===doc.id&&
    target.key===input.documentKey&&target.revisionId===doc.latestRevisionId&&
    review.resolvedByAgentId===qa&&review.resolvedByAgentId!==doc.createdByAgentId&&review.resolvedByAgentId!==input.actorId&&
    review.resolvedByRunId&&review.resolvedByRunId!==review.sourceRunId&&
    input.run?.id===review.resolvedByRunId&&input.run.companyId===input.companyId&&input.run.agentId===qa&&input.run.status==="succeeded",
    "republication_independent_same_version_review");
  publicationNeed(!registry.entries.some(p=>p.path===draft.path||p.documentId===doc.id),"republication_new_document_and_path");
  // The machine header records lineage, including the held previous version.
  // Only rendered Markdown links form the navigation/citation index.
  const body=doc.latestBody.slice(doc.latestBody.indexOf(END,PREFIX.length)+END.length);
  const backlinks=extractWikiLinks(body);
  for(const path of backlinks){
    if(path===draft.path)continue;
    const held=await input.readers.retraction!(path);
    if(held)throw new Error("E_SOURCE_RETRACTED "+JSON.stringify(held));
    publicationNeed(draft.dependencies.some(ref=>ref.path===path),"republication_undeclared_body_reference");
  }
  const refs:JsonObject[]=[{kind:"document",issueId:input.issueId,documentId:doc.id,documentKey:input.documentKey,revisionId:doc.latestRevisionId}];
  for(const ref of draft.dependencies){
    const matches=registry.entries.filter(p=>p.path===ref.path&&p.wikiSHA256===ref.wikiSHA256);
    publicationNeed(matches.length===1,"republication_dependency_changed");
    const proof=await verifyWikiPublication(registry,ref.path,input.readers);
    publicationNeed(proof.state==="verified"&&!proof.invalidatedCitations?.length,"republication_dependency_held");
    const p=matches[0]!;refs.push({kind:"document",issueId:p.issueId,documentId:p.documentId,documentKey:p.documentKey,revisionId:p.revisionId});
  }
  const pin:PublicationPin={path:draft.path,issueId:input.issueId,documentId:doc.id,documentKey:input.documentKey,revisionId:doc.latestRevisionId,
    producerAgentId:doc.createdByAgentId,qaAgentId:qa,reviewId:review.id,wikiSHA256:publicationHash(doc.latestBody),
    documentBodySHA256:publicationHash(doc.latestBody),reviewRecordSHA256:publicationHash(publicationCanonical(reviewBasis(review as unknown as JsonObject))),
    sourceRefsSHA256:publicationHash(publicationCanonical(refs))};
  const nextRegistry={...registry,entries:[...registry.entries,pin]};
  return {draft,parent,pin,sourceRefs:refs,backlinks,contents:doc.latestBody,nextRegistry,
    registryBeforeSHA256:publicationHash(publicationCanonical(registry)),registryAfterSHA256:publicationHash(publicationCanonical(nextRegistry)),
    reviewId:review.id,reviewerId:qa,reviewRunId:review.resolvedByRunId!};
}
export function buildWikiRepublicationEvent(plan:Awaited<ReturnType<typeof resolveReviewedWikiRepublication>>,input:{
  events:RetractionEvent[];operationId:string;actorId:string;eventId:string;at:string;issueId:string;documentKey:string;
}) : RetractionEvent {
  const {draft,parent,pin}=plan;const target={companyId:draft.companyId,wikiId:draft.wikiId,spaceSlug:draft.spaceSlug,path:draft.path,contentHash:pin.wikiSHA256};
  const basis:Omit<RetractionEvent,"eventHash">={...target,schema:"paperclip.wiki-retraction/v1",id:input.eventId,sequence:input.events.length+1,
    previousHash:input.events.at(-1)?.eventHash??null,type:"republished",retractionId:parent.retractionId,reason:draft.reason,actorId:input.actorId,runId:null,at:input.at,
    approval:{id:plan.reviewId,companyId:draft.companyId,target,reason:draft.reason,reviewerId:plan.reviewerId,reviewRunId:plan.reviewRunId,
      // Lineage to the withdrawal's actual human decision, not a new consent
      // to this body. Publication authority is the Board route plus new QA.
      ownerDecisionId:parent.approval.ownerDecisionId,proposal:{issueId:input.issueId,documentKey:input.documentKey,documentId:pin.documentId,
        revisionId:pin.revisionId,bodySHA256:pin.documentBodySHA256,registrySHA256:plan.registryBeforeSHA256}},
    republication:{operationId:input.operationId,retractionEventHash:parent.eventHash,previousPath:(parent.fence!.pathPrefix?parent.fence!.pathPrefix+"/":"")+draft.previousPath,
      physicalPath:(parent.fence!.pathPrefix?parent.fence!.pathPrefix+"/":"")+draft.path,rootPath:parent.fence!.rootPath,producerAgentId:pin.producerAgentId,
      documentId:pin.documentId,revisionId:pin.revisionId,sourceRefsSHA256:pin.sourceRefsSHA256,reviewRecordSHA256:pin.reviewRecordSHA256,registryBeforeSHA256:plan.registryBeforeSHA256,registryAfterSHA256:plan.registryAfterSHA256}};
  const event={...basis,eventHash:retractionEventHash(basis)};validateRetractionEvents(draft,[...input.events,event]);return event;
}

/** Shared host check for a republished page. Every actual byte reader uses it,
 * including UI and discovery, rather than relying on the publication-time QA. */
export function verifyCurrentWikiRepublication(input:{event:RetractionEvent;registry:PublicationRegistry;
  document:RepublicationDocument|null;review:RepublicationReview|null;
  run:{id:string;companyId:string;agentId:string;status:string}|null}) {
  const {event,registry,document:doc,review,run}=input,p=event.republication;
  publicationNeed(event.type==="republished"&&p,"republication_current_event");
  const pin=registry.entries.find(x=>x.path===event.path);
  publicationNeed(registry.companyId===event.companyId&&registry.wikiId===event.wikiId&&registry.spaceSlug===event.spaceSlug&&pin&&
    pin.documentId===p.documentId&&pin.revisionId===p.revisionId&&pin.producerAgentId===p.producerAgentId&&
    pin.wikiSHA256===event.contentHash&&pin.documentBodySHA256===event.contentHash&&pin.sourceRefsSHA256===p.sourceRefsSHA256&&
    pin.reviewId===event.approval.id&&pin.reviewRecordSHA256===p.reviewRecordSHA256&&
    (pin.qaAgentId??registry.qaAgentId)===event.approval.reviewerId,"republication_current_pin");
  publicationNeed(doc&&doc.id===p.documentId&&doc.companyId===event.companyId&&doc.latestRevisionId===p.revisionId&&
    doc.createdByAgentId===p.producerAgentId&&doc.updatedByAgentId===p.producerAgentId&&!doc.updatedByUserId&&
    publicationHash(doc.latestBody)===event.contentHash,"republication_current_document");
  publicationNeed(review&&review.id===event.approval.id&&review.companyId===event.companyId&&review.issueId===pin.issueId&&
    review.kind==="request_confirmation"&&review.status==="accepted"&&(review.result as {outcome?:string}|null)?.outcome==="accepted"&&
    review.resolvedByAgentId===event.approval.reviewerId&&review.resolvedByRunId===event.approval.reviewRunId&&
    publicationHash(publicationCanonical(reviewBasis(review as unknown as JsonObject)))===p.reviewRecordSHA256&&
    run&&run.id===event.approval.reviewRunId&&run.companyId===event.companyId&&run.agentId===event.approval.reviewerId&&run.status==="succeeded",
    "republication_current_review");
}
