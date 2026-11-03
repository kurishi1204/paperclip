import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { activityLog, documents, heartbeatRuns, issueDocuments, issueThreadInteractions, pluginConfig, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { pluginDatabaseService } from "./plugin-database.js";
import { assertConfiguredLocalFolder, createPluginLocalFolderTextExclusive, getStoredLocalFolders, inspectPluginLocalFolder,
  readPluginLocalFolderText, requireLocalFolderDeclaration } from "./plugin-local-folders.js";
import { loadAllWikiRetractions, withWikiRetractionLock, appendRetractionMaintenanceLog, assertWikiRetractionSpaceBindings } from "./wiki-retraction-store.js";
import { retractionFolderGate, readRetractionFolderTextWithStatus, canonicalWikiRetractionPath } from "./wiki-retraction-gate.js";
import { parsePublicationRegistry, publicationCanonical, publicationHash, publicationNeed, verifyWikiPublication, type JsonObject } from "./wiki-publication-readback.js";
import { buildWikiRepublicationEvent, parseWikiRepublicationDraft, resolveReviewedWikiRepublication, verifyCurrentWikiRepublication } from "./wiki-republication.js";
import { withRetractionMaintenanceLog, retainedRetractionFile, type RetractionEvent } from "./wiki-retraction-ledger.js";

interface Request { companyId:string;issueId:string;documentKey:string;reviewId:string;operationId:string;actorId:string; }
const WIKI_PLUGIN="paperclipai.plugin-llm-wiki";
export async function assertWikiRepublicationTargetPath(root:string,physicalPath:string) {
  publicationNeed(await canonicalWikiRetractionPath(root,physicalPath)===physicalPath,"republication_alias");
}
/** Current proof for registered originals and new versions. The existing
 * export name is retained for the host/route contract. */
export async function assertCurrentWikiRepublication(db:Db,pluginId:string,companyId:string,events:RetractionEvent[],physicalPath:string) {
  // Validate current namespace identity before physical-path classification;
  // a new prefix must not make every recorded target look unrelated.
  await assertWikiRetractionSpaceBindings(db,pluginId,companyId,events);
  const matches=events.filter(e=>e.type==="republished"&&e.republication?.physicalPath===physicalPath);
  const originals=events.filter(e=>e.type==="executed"&&e.fence&&
    [...e.fence.blocks,...e.fence.readable].some(p=>p.path===physicalPath)),original=originals[0];
  if(!matches.length&&!original)return;
  publicationNeed(matches.length<=1,"republication_current_identity");const event=matches[0]??original!;
  const configs=await db.select().from(pluginConfig).where(and(eq(pluginConfig.pluginId,pluginId),eq(pluginConfig.companyId,companyId))).for("share");
  const registry=parsePublicationRegistry(configs[0]?.configJson.publicationReadback,companyId);
  const pluginDb=pluginDatabaseService(db),ns=await pluginDb.getRuntimeNamespace(pluginId);
  const spaces=await pluginDb.query<{id:string;path_prefix:string|null;root_folder_key:string;status:string}>(pluginId,
    `SELECT id,path_prefix,root_folder_key,status FROM ${ns}.wiki_spaces WHERE company_id=$1 AND wiki_id=$2 AND slug=$3 FOR SHARE`,[companyId,registry.wikiId,registry.spaceSlug]);
  publicationNeed(spaces.length===1&&spaces[0]!.root_folder_key==="wiki-root"&&spaces[0]!.status==="active"&&
    registry.wikiId===event.wikiId&&registry.spaceSlug===event.spaceSlug,"republication_current_space");
  const physical=(p:string)=>spaces[0]!.path_prefix?spaces[0]!.path_prefix+"/"+p:p;
  const target=registry.entries.find(p=>physical(p.path)===physicalPath);
  // Classification is persisted with the withdrawal, never inferred from
  // today's editable registry. Missing historical classification is unknown.
  if(!target){
    publicationNeed(!matches.length&&originals.length>0&&originals.every(e=>e.fence?.registeredPaths!==undefined&&
      !e.fence.registeredPaths.includes(physicalPath)),"republication_current_pin");
    return;
  }
  if(matches.length)publicationNeed(physical(event.path)===physicalPath,"republication_current_physical_path");
  const gate=retractionFolderGate(events,companyId,"wiki-root"),root=event.republication?.rootPath??original!.fence!.rootPath;gate.assertRoot(root);
  const loadDocument=async(issueId:string,key:string)=>{
    const rows=await db.select({doc:documents}).from(issueDocuments).innerJoin(documents,eq(issueDocuments.documentId,documents.id))
      .where(and(eq(issueDocuments.companyId,companyId),eq(issueDocuments.issueId,issueId),eq(issueDocuments.key,key))).for("share",{of:documents});
    return rows[0]?{...rows[0].doc,body:rows[0].doc.latestBody,issueId}:null;
  };
  const loadRun=async(id:string)=>{
    const rows=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,id),eq(heartbeatRuns.companyId,companyId))).for("share");return rows[0]??null;
  };
  const loadReview=async(issueId:string,id:string)=>{
    const rows=await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id,id),eq(issueThreadInteractions.companyId,companyId),eq(issueThreadInteractions.issueId,issueId))).for("share");
    const review=rows[0]??null,run=review?.resolvedByRunId?await loadRun(review.resolvedByRunId):null;
    publicationNeed(run&&run.status==="succeeded"&&run.agentId===review?.resolvedByAgentId,"republication_dependency_review_run");return {...review,resolvedRun:run};
  };
  // UI and planning use the same recursive publication proof as the tool.
  // Actual namespace rows, current document/review/run and guarded file bytes
  // participate; a parallel partial UI proof is not maintained here.
  await verifyWikiPublication(registry,target.path,{
    retraction:async p=>gate.block(physical(p)),document:loadDocument,review:loadReview,
    page:async p=>{
      const rows=await pluginDb.query<{source_refs:unknown;content_hash:string}>(pluginId,
        `SELECT source_refs,content_hash FROM ${ns}.wiki_pages WHERE company_id=$1 AND wiki_id=$2 AND space_id=$3 AND path=$4 FOR SHARE`,[companyId,registry.wikiId,spaces[0]!.id,p]);
      publicationNeed(rows.length===1,"republication_current_page");
      const {contents}=await readRetractionFolderTextWithStatus(root,physical(p),gate);
      const current=events.find(e=>e.type==="republished"&&e.republication?.physicalPath===physical(p));
      if(current){
        const pin=registry.entries.find(x=>x.path===p);publicationNeed(pin,"republication_current_pin");
        verifyCurrentWikiRepublication({event:current,registry,document:await loadDocument(pin.issueId,pin.documentKey),
          review:await loadReview(pin.issueId,current.approval.id),run:await loadRun(current.approval.reviewRunId)});
      }
      return {path:p,wikiId:registry.wikiId,spaceSlug:registry.spaceSlug,contents,hash:rows[0]!.content_hash,sourceRefs:rows[0]!.source_refs};
    },
  });
}
export function wikiRepublicationRuntime(db:Db,pluginId:string) {
  async function document(tx:Db,companyId:string,issueId:string,key:string) {
    const rows=await tx.select({doc:documents}).from(issueDocuments).innerJoin(documents,eq(issueDocuments.documentId,documents.id))
      .where(and(eq(issueDocuments.companyId,companyId),eq(issueDocuments.issueId,issueId),eq(issueDocuments.key,key))).for("update",{of:documents});
    const row=rows[0]?.doc;return row?{...row,body:row.latestBody,issueId}:null;
  }
  async function review(tx:Db,companyId:string,issueId:string,id:string) {
    const rows=await tx.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id,id),
      eq(issueThreadInteractions.companyId,companyId),eq(issueThreadInteractions.issueId,issueId))).for("update");return rows[0]??null;
  }
  function committed(events:RetractionEvent[],input:Request) {
    const event=events.find(e=>e.type==="republished"&&e.republication?.operationId===input.operationId);
    if(event&&(event.actorId!==input.actorId||event.approval.id!==input.reviewId||event.approval.proposal?.issueId!==input.issueId||
      event.approval.proposal.documentKey!==input.documentKey))throw conflict("operationId belongs to another publication");
    return event;
  }
  async function plan(tx:Db,input:Request,all:RetractionEvent[]) {
    await assertWikiRetractionSpaceBindings(tx,pluginId,input.companyId,all);
    const registryService=pluginRegistryService(tx),plugin=await registryService.getById(pluginId);
    if(!plugin||plugin.pluginKey!==WIKI_PLUGIN)throw notFound("Wiki plugin not found");
    const configs=await tx.select().from(pluginConfig).where(and(eq(pluginConfig.pluginId,pluginId),eq(pluginConfig.companyId,input.companyId))).for("update");
    const config=configs[0];publicationNeed(config,"republication_config");
    const pins=parsePublicationRegistry(config.configJson.publicationReadback,input.companyId);
    const draftDoc=await document(tx,input.companyId,input.issueId,input.documentKey);publicationNeed(draftDoc,"republication_document");
    const draft=parseWikiRepublicationDraft(draftDoc.latestBody);
    const settings=await registryService.getCompanySettings(pluginId,input.companyId);
    const folder=await inspectPluginLocalFolder({folderKey:"wiki-root",declaration:requireLocalFolderDeclaration(plugin.manifestJson.localFolders,"wiki-root"),
      storedConfig:getStoredLocalFolders(settings?.settingsJson)["wiki-root"]??null});
    assertConfiguredLocalFolder(folder);publicationNeed(folder.writable,"republication_folder_write_access");const root=folder.realPath!;
    const gate=retractionFolderGate(all,input.companyId,"wiki-root");gate.assertRoot(root);
    const pluginDb=pluginDatabaseService(tx),ns=await pluginDb.getRuntimeNamespace(pluginId);
    const spaces=await pluginDb.query<{id:string;path_prefix:string|null;root_folder_key:string;status:string}>(pluginId,
      `SELECT id,path_prefix,root_folder_key,status FROM ${ns}.wiki_spaces WHERE company_id=$1 AND wiki_id=$2 AND slug=$3 FOR SHARE`,[input.companyId,draft.wikiId,draft.spaceSlug]);
    publicationNeed(spaces.length===1&&spaces[0]!.root_folder_key==="wiki-root"&&spaces[0]!.status==="active","republication_space");
    const space=spaces[0]!,physical=(p:string)=>space.path_prefix?space.path_prefix+"/"+p:p;
    const rows=await pluginDb.query<{path:string;source_refs:unknown;content_hash:string;page_type:string|null}>(pluginId,
      `SELECT path,source_refs,content_hash,page_type FROM ${ns}.wiki_pages WHERE company_id=$1 AND wiki_id=$2 AND space_id=$3 FOR SHARE`,[input.companyId,draft.wikiId,space.id]);
    publicationNeed(!rows.some(r=>r.path===draft.path),"republication_path_already_indexed");
    const qa=await review(tx,input.companyId,input.issueId,input.reviewId);
    const runs=qa?.resolvedByRunId?await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,qa.resolvedByRunId),eq(heartbeatRuns.companyId,input.companyId))).for("update"):[];
    const events=all.filter(e=>e.wikiId===draft.wikiId&&e.spaceSlug===draft.spaceSlug).sort((a,b)=>a.sequence-b.sequence);
    const resolved=await resolveReviewedWikiRepublication({...input,document:draftDoc,review:qa,run:runs[0]??null,registry:pins,events,
      readers:{document:(issueId,key)=>document(tx,input.companyId,issueId,key),review:async(issueId,id)=>{
        const current=await review(tx,input.companyId,issueId,id);
        const currentRuns=current?.resolvedByRunId?await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,current.resolvedByRunId),eq(heartbeatRuns.companyId,input.companyId))).for("share"):[];
        publicationNeed(currentRuns[0]?.status==="succeeded"&&currentRuns[0]?.agentId===current?.resolvedByAgentId,"republication_dependency_review_run");return {...current,resolvedRun:currentRuns[0]};
      },
        retraction:async p=>gate.block(physical(p)),page:async p=>{
          await assertCurrentWikiRepublication(tx,pluginId,input.companyId,all,physical(p));
          const matches=rows.filter(r=>r.path===p);publicationNeed(matches.length===1,"republication_page_metadata");
          const {contents}=await readRetractionFolderTextWithStatus(root,physical(p),gate);const hash=publicationHash(contents);
          publicationNeed(matches[0]!.content_hash===hash,"republication_page_changed");
          return {path:p,wikiId:draft.wikiId,spaceSlug:draft.spaceSlug,contents,hash,sourceRefs:matches[0]!.source_refs};
        }}});
    // A missing/pending log is known before we reserve an operation identity.
    // Do not strand an intent merely because the previous derived append is
    // still waiting for the same host lock.
    const logPath=physical("wiki/log.md"),logContents=await readPluginLocalFolderText(root,logPath);
    const previousLog=events.filter(e=>e.maintenanceLog?.path===logPath).at(-1)?.maintenanceLog;
    if(previousLog)retainedRetractionFile(events,logPath,previousLog.resultingSHA256,logContents);
    else {
      const logPin=resolved.parent.fence!.blocks.find(b=>b.path===logPath);
      publicationNeed(logPin&&publicationHash(logContents)===logPin.contentHash,"republication_log_changed");
    }
    const newPhysical=physical(draft.path);
    await assertWikiRepublicationTargetPath(root,newPhysical);
    return {resolved,events,root,newPhysical,pluginDb,space,ns,config,pageType:rows.find(r=>r.path===draft.previousPath)!.page_type,planHash:publicationHash(publicationCanonical({pin:resolved.pin,
      sourceRefs:resolved.sourceRefs,root,physicalPath:newPhysical,logSHA256:publicationHash(logContents),registryBefore:resolved.registryBeforeSHA256,registryAfter:resolved.registryAfterSHA256}))};
  }
  return {
    async execute(input:Request) {
      // Commit an intent before the first filesystem effect. A pending intent
      // is never automatically resumed: ambiguous effects require readback.
      const first=await withWikiRetractionLock(db,pluginId,input.companyId,async tx=>{
        const all=await loadAllWikiRetractions(tx,pluginId,input.companyId);retractionFolderGate(all,input.companyId,"wiki-root");
        const receipt=committed(all,input);if(receipt)return {receipt};
        const prior=await tx.select({id:activityLog.id}).from(activityLog).where(eq(activityLog.id,input.operationId));
        if(prior.length)throw conflict("Publication is prepared or outcome is unknown; read its receipt, do not resend");
        const p=await plan(tx,input,all);
        await tx.insert(activityLog).values({id:input.operationId,companyId:input.companyId,actorType:"user",actorId:input.actorId,
          action:"wiki.page.republication_prepared",entityType:"wiki_republication",entityId:pluginId,
          details:{schema:"paperclip.wiki-republication-intent/v1",...input,pluginId,planHash:p.planHash,path:p.newPhysical,rootPath:p.root,contentHash:p.resolved.pin.wikiSHA256}});
        return {planHash:p.planHash};
      });
      if(first.receipt)return first.receipt;
      const receipt = await withWikiRetractionLock(db,pluginId,input.companyId,async tx=>{
        const all=await loadAllWikiRetractions(tx,pluginId,input.companyId);retractionFolderGate(all,input.companyId,"wiki-root");
        const p=await plan(tx,input,all);publicationNeed(p.planHash===first.planHash,"republication_plan_changed");
        const initialEvent=buildWikiRepublicationEvent(p.resolved,{...input,events:p.events,eventId:randomUUID(),at:new Date().toISOString()});
        const logPath=(p.space.path_prefix?p.space.path_prefix+"/":"")+"wiki/log.md";
        const event=withRetractionMaintenanceLog(initialEvent,p.events,await readPluginLocalFolderText(p.root,logPath));
        const created=await createPluginLocalFolderTextExclusive(p.root,p.newPhysical,p.resolved.contents);
        if(!created.created)throw conflict("Publication file already exists; it was not overwritten. Read intent/receipt without retry");
        await assertWikiRepublicationTargetPath(p.root,p.newPhysical);
        publicationNeed(publicationHash(await readPluginLocalFolderText(p.root,p.newPhysical))===event.contentHash,"republication_file_readback");
        const pageId=randomUUID(),revisionId=randomUUID(),title=p.resolved.contents.match(/^#\s+(.+)$/m)?.[1]??p.resolved.draft.path;
        await p.pluginDb.execute(pluginId,`INSERT INTO ${p.ns}.wiki_pages
          (id,company_id,wiki_id,space_id,path,title,page_type,frontmatter,source_refs,backlinks,content_hash,current_revision_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8::jsonb,'[]'::jsonb,$9,$10)`,
          [pageId,input.companyId,p.resolved.draft.wikiId,p.space.id,p.resolved.draft.path,title,p.pageType,JSON.stringify(p.resolved.sourceRefs),event.contentHash,revisionId]);
        await p.pluginDb.execute(pluginId,`INSERT INTO ${p.ns}.wiki_page_revisions
          (id,company_id,wiki_id,space_id,page_id,path,content_hash,summary,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[revisionId,input.companyId,p.resolved.draft.wikiId,p.space.id,pageId,
          p.resolved.draft.path,event.contentHash,p.resolved.draft.reason,JSON.stringify({operationId:input.operationId,replaces:p.resolved.draft.previousPath})]);
        await tx.update(pluginConfig).set({configJson:{...p.config.configJson,publicationReadback:p.resolved.nextRegistry},updatedAt:new Date()})
          .where(and(eq(pluginConfig.id,p.config.id),eq(pluginConfig.companyId,input.companyId)));
        await tx.insert(activityLog).values({id:event.id,companyId:input.companyId,actorType:"user",actorId:input.actorId,
          action:"wiki.page.retraction",entityType:"wiki_retraction",entityId:pluginId,details:event as unknown as JsonObject});
        return event;
      });
      try {
        await withWikiRetractionLock(db,pluginId,input.companyId,async tx=>{
          await appendRetractionMaintenanceLog(receipt,await loadAllWikiRetractions(tx,pluginId,input.companyId));
        });
      }catch(cause){
        // Only this already-committed phase is normalized. Intent/file/DB
        // failures and authorization conflicts retain their original errors.
        const unresolved=conflict("Publication committed; maintenance append unresolved. Read the existing receipt; do not retry",{
          code:"wiki_republication_post_commit_unresolved",operationId:input.operationId,eventId:receipt.id,automaticRetryAllowed:false,
        });
        unresolved.cause=cause;throw unresolved;
      }
      return receipt;
    },
    async receipt(companyId:string,operationId:string) {
      return withWikiRetractionLock(db,pluginId,companyId,async tx=>{
        const events=await loadAllWikiRetractions(tx,pluginId,companyId);retractionFolderGate(events,companyId,"wiki-root");
        const event=events.find(e=>e.type==="republished"&&e.republication?.operationId===operationId);
        const intents=await tx.select().from(activityLog).where(and(eq(activityLog.id,operationId),eq(activityLog.companyId,companyId),
          eq(activityLog.entityId,pluginId),eq(activityLog.action,"wiki.page.republication_prepared")));
        const intent=intents[0]?.details as {rootPath:string;path:string;contentHash:string}|undefined;
        if(!intent&&!event)throw notFound("Publication operation not found");
        let file:{present:boolean;sha256?:string;matchesIntent?:boolean}={present:false};
        if(intent)try{const body=await readPluginLocalFolderText(intent.rootPath,intent.path);const sha256=publicationHash(body);file={present:true,sha256,matchesIntent:sha256===intent.contentHash};}
        catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
        let maintenanceLog: {state:string;sha256?:string;error?:string}={state:"not_recorded"};
        if(event?.maintenanceLog) {
          const log=event.maintenanceLog;
          try {
            const contents=await readPluginLocalFolderText(log.rootPath,log.path);
            retainedRetractionFile(events.filter(e=>e.wikiId===event.wikiId&&e.spaceSlug===event.spaceSlug),log.path,log.prefixSHA256,contents);
            const sha256=publicationHash(contents);
            // The complete log may contain later valid appends. The verifier
            // above has checked every recorded prefix and exact append; use
            // this event's byte range rather than the latest file hash.
            const appendEnd=log.prefixBytes+Buffer.byteLength(log.appendText);
            maintenanceLog={state:Buffer.byteLength(contents)>=appendEnd?"appended":"pending",sha256};
          } catch(error) {maintenanceLog={state:"unknown",error:error instanceof Error?error.message:"log read failed"};}
        }
        return {state:event?"published":"prepared_or_unknown",event:event??null,file,maintenanceLog,automaticRetryAllowed:false};
      });
    },
  };
}
