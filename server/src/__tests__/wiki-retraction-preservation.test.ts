import { mkdtemp,mkdir,readFile,realpath,rm,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe,it,expect } from "vitest";
import { executeRetraction,validateRetractionEvents,retractionEventHash,type RetractionEvent,type RetractionStore } from "../services/wiki-retraction-ledger.js";
import { retractionFolderGate,readRetractionFolderText,readRetractionFolderTextWithStatus } from "../services/wiki-retraction-gate.js";
import { preserveExistingRetractionPages, inventoryRetractionPages } from "../services/wiki-retraction-readback.js";
import { publicationCanonical,publicationHash,type PublicationRegistry } from "../services/wiki-publication-readback.js";

const hash=publicationHash("synthetic");
const pins:PublicationRegistry["entries"]=["p7","upstream"].map(name=>({path:`wiki/${name}.md`,issueId:`issue-${name}`,
  documentId:`doc-${name}`,documentKey:name,revisionId:`revision-${name}`,producerAgentId:"author",reviewId:`review-${name}`,
  wikiSHA256:hash,documentBodySHA256:hash,reviewRecordSHA256:hash,sourceRefsSHA256:hash}));
const kept="wiki/legacy.md",held=new Set(["wiki/p7.md","wiki/index.md","wiki/log.md"]);
const body="# Existing page\n\n[Independent](upstream.md)\n",refs=[{kind:"historical_input",note:"existing record"}];
const row={path:kept,content_hash:publicationHash(body),source_refs:refs};
const read=async(path:string)=>({path,contents:body});
const noPriorHold=retractionFolderGate([],"synthetic-company","wiki-root");

describe("explicit existing-page preservation",()=>{
  it("pins actual retained bytes and complete references without registering a page",async()=>{
    const dir=await realpath(await mkdtemp(join(tmpdir(),"wiki-preserved-page-")));
    try{
      await mkdir(join(dir,"wiki"));
      await writeFile(join(dir,kept),body);
      const measured=await preserveExistingRetractionPages(pins,[row],held,[kept],async path=>({path,contents:await readFile(join(dir,kept),"utf8")}),noPriorHold);
      expect(measured).toEqual([{path:kept,contentHash:publicationHash(body),sourceRefsSHA256:publicationHash(publicationCanonical(refs))}]);
      expect(pins.some(pin=>pin.path===kept)).toBe(false);
      expect(await preserveExistingRetractionPages(pins,[row],held,[],read,noPriorHold)).toEqual([]);
      expect(await readFile(join(dir,kept),"utf8")).toBe(body);
      const events:RetractionEvent[]=[];
      const store:RetractionStore={read:async()=>events,transaction:async(_scope,work)=>work({events:async()=>events,append:async e=>{events.push(e);}})};
      const target={companyId:"synthetic-company",wikiId:"default",spaceSlug:"default",path:"wiki/p7.md",contentHash:hash};
      const event=await executeRetraction(store,{target,retractionId:"synthetic-operation",eventId:"synthetic-event",
        reason:"Synthetic retained-page read",actorId:"synthetic-owner",runId:null,at:new Date().toISOString(),
        approval:{id:"synthetic-review",companyId:target.companyId,target,reason:"Synthetic retained-page read",
          reviewerId:"synthetic-qa",reviewRunId:"synthetic-run",ownerDecisionId:"synthetic-human"},
        fence:{folderKey:"wiki-root",rootPath:dir,pathPrefix:"",mode:"citation-holds",registeredPaths:[target.path],
          blocks:[{path:target.path,contentHash:hash,state:"retracted"},...measured.map(({path,contentHash})=>({path,contentHash,state:"blocked_by_retraction" as const}))],readable:[],preservedPages:measured},
        readCurrent:async()=>target});
      const gate=retractionFolderGate(events,target.companyId,"wiki-root");
      const inspected=await readRetractionFolderTextWithStatus(dir,kept,gate);
      expect(inspected.contents).toBe(body);
      expect(inspected.citationHolds).toHaveLength(1);
      expect(inspected.citationHolds[0]!.reason).toContain("未検証の旧出典");
      await expect(readRetractionFolderText(dir,kept,gate)).rejects.toThrow(/E_SOURCE_RETRACTED/);
      await expect(readRetractionFolderText(dir,target.path,gate)).rejects.toThrow(/E_SOURCE_RETRACTED/);
      await writeFile(join(dir,"wiki/future.md"),"Not selected");
      await expect(readRetractionFolderText(dir,"wiki/future.md",gate)).rejects.toThrow(/E_SOURCE_RETRACTED/);
      const retainedAgain=await preserveExistingRetractionPages(pins,[row],held,[kept],read,gate);
      expect(retainedAgain).toEqual(measured);
      const nextFence={folderKey:"wiki-root" as const,rootPath:dir,pathPrefix:"",mode:"citation-holds" as const,
        registeredPaths:[target.path,"wiki/upstream.md"],blocks:[{path:"wiki/upstream.md",contentHash:hash,state:"retracted" as const},
          ...retainedAgain.map(({path,contentHash})=>({path,contentHash,state:"blocked_by_retraction" as const}))],
        readable:[{path:target.path,contentHash:hash}],preservedPages:retainedAgain};
      const nextRows=[row,{path:target.path,content_hash:hash,source_refs:[]}];
      expect(inventoryRetractionPages(nextRows,nextFence,gate).find(p=>p.path===target.path)).toMatchObject({readControl:"retracted",readPolicy:"strict"});
      const nextTarget={...target,path:"wiki/upstream.md"};
      await executeRetraction(store,{target:nextTarget,retractionId:"second-operation",eventId:"second-event",reason:"Second synthetic withdrawal",
        actorId:"synthetic-owner",runId:null,at:new Date().toISOString(),fence:nextFence,readCurrent:async()=>nextTarget,
        approval:{id:"second-review",companyId:target.companyId,target:nextTarget,reason:"Second synthetic withdrawal",reviewerId:"synthetic-qa",reviewRunId:"second-run",ownerDecisionId:"second-human"}});
      const combined=retractionFolderGate(events,target.companyId,"wiki-root");
      expect((await readRetractionFolderTextWithStatus(dir,kept,combined)).citationHolds).toHaveLength(2);
      await expect(readRetractionFolderText(dir,kept,combined)).rejects.toThrow(/E_SOURCE_RETRACTED/);
      await expect(readRetractionFolderTextWithStatus(dir,target.path,combined)).rejects.toThrow(/E_SOURCE_RETRACTED/);
      const invalid=structuredClone(event);invalid.fence!.preservedPages![0]!.sourceRefsSHA256="invalid";
      const {eventHash:_old,...basis}=invalid;invalid.eventHash=retractionEventHash(basis);
      expect(()=>validateRetractionEvents(target,[invalid])).toThrow(/fence_preserved_page/);
      const registered=structuredClone(event);registered.fence!.registeredPaths!.push(kept);
      const {eventHash:_registered,...registeredBasis}=registered;registered.eventHash=retractionEventHash(registeredBasis);
      expect(()=>validateRetractionEvents(target,[registered])).toThrow(/fence_preserved_page/);
      // A later proposal cannot claim to preserve a page that an earlier
      // durable fence still refuses. The prior event remains immutable.
      const prior=structuredClone(event);prior.fence!.readable=[];prior.fence!.mode="freeze-wiki";delete prior.fence!.preservedPages;
      const {eventHash:_prior,...priorBasis}=prior;prior.eventHash=retractionEventHash(priorBasis);
      const priorGate=retractionFolderGate([prior],target.companyId,"wiki-root");
      expect(()=>priorGate.assertRead(kept,body)).toThrow(/E_SOURCE_RETRACTED/);
      await expect(preserveExistingRetractionPages(pins,[row],held,[kept],read,priorGate)).rejects.toThrow(/E_SOURCE_RETRACTED/);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it("refuses missing, duplicate, registered and held selections",async()=>{
    await expect(preserveExistingRetractionPages(pins,[row],held,[kept,kept],read,noPriorHold)).rejects.toThrow(/preserve_paths/);
    await expect(preserveExistingRetractionPages(pins,[row],held,["wiki/absent.md"],read,noPriorHold)).rejects.toThrow(/preserve_metadata/);
    await expect(preserveExistingRetractionPages(pins,[row],held,["wiki/upstream.md"],read,noPriorHold)).rejects.toThrow(/preserve_path/);
    await expect(preserveExistingRetractionPages(pins,[row],held,["wiki/p7.md"],read,noPriorHold)).rejects.toThrow(/preserve_path/);
  });
  it("keeps opaque, partial and fragment references unverified without guessing independence",async()=>{
    const values=["doc-p7","issue-p7","revision-p7","wiki/p7.md#claim","wiki/p7.md?view=source#claim","./p7.md#claim","%77iki/p7.md#claim","[[p7#claim|reference]]","[input](p7.md#claim)"];
    for(const value of values){
      const source_refs=[{kind:"unfamiliar-shape",nested:{arbitrary:value}}];
      const measured=await preserveExistingRetractionPages(pins,[{...row,source_refs}],held,[kept],read,noPriorHold);
      expect(measured).toEqual([{path:kept,contentHash:row.content_hash,sourceRefsSHA256:publicationHash(publicationCanonical(source_refs))}]);
      // Every selected result is a metadata pin, never a readable decision.
      expect(Object.keys(measured[0]!).sort()).toEqual(["contentHash","path","sourceRefsSHA256"]);
    }
  });
  it("never upgrades retained unregistered data to an unconditional readable event",()=>{
    const target={companyId:"synthetic-company",wikiId:"default",spaceSlug:"default",path:"wiki/p7.md",contentHash:hash};
    const basis={...target,schema:"paperclip.wiki-retraction/v1" as const,id:"synthetic-event",retractionId:"synthetic-operation",sequence:1,previousHash:null,type:"executed" as const,reason:"Synthetic retained legacy source",actorId:"synthetic-owner",runId:null,at:new Date().toISOString(),
      approval:{id:"synthetic-review",companyId:target.companyId,target,reason:"Synthetic retained legacy source",reviewerId:"synthetic-qa",reviewRunId:"synthetic-run",ownerDecisionId:"synthetic-human"},
      fence:{folderKey:"wiki-root" as const,rootPath:"/synthetic",pathPrefix:"",mode:"citation-holds" as const,registeredPaths:[target.path],blocks:[{path:target.path,contentHash:hash,state:"retracted" as const}],
        readable:[{path:kept,contentHash:row.content_hash}],preservedPages:[{path:kept,contentHash:row.content_hash,sourceRefsSHA256:publicationHash(publicationCanonical(refs))}]}};
    const event={...basis,eventHash:retractionEventHash(basis)};
    expect(()=>validateRetractionEvents(target,[event])).toThrow(/fence_preserved_page/);
  });
  it("retains linked original bytes as inspection input without classifying their sources",async()=>{
    for(const link of ["p7.md","unreviewed.md"]){
      const contents=`[Input](${link})\n`,rows=[{...row,content_hash:publicationHash(contents)}];
      const measured=await preserveExistingRetractionPages(pins,rows,held,[kept],async path=>({path,contents}),noPriorHold);
      expect(measured[0]!.contentHash).toBe(publicationHash(contents));
    }
  });
  it("enumerates every metadata row before classifying even partial unselected references",()=>{
    const other="wiki/not-selected.md",partial=[{kind:"document",documentId:"doc-p7"}];
    const fence={folderKey:"wiki-root" as const,rootPath:"/synthetic",pathPrefix:"scope",mode:"citation-holds" as const,
      registeredPaths:["scope/wiki/p7.md"],readable:[],blocks:[{path:"scope/wiki/p7.md",contentHash:hash,state:"retracted" as const},
        {path:"scope/"+kept,contentHash:row.content_hash,state:"blocked_by_retraction" as const}]};
    const rows=[row,{path:other,content_hash:hash,source_refs:partial},{path:"wiki/p7.md",content_hash:hash,source_refs:[]}];
    const inventory=inventoryRetractionPages(rows,fence,noPriorHold);expect(inventory).toHaveLength(rows.length);
    expect(new Set(inventory.map(p=>p.path))).toEqual(new Set(rows.map(p=>p.path)));
    expect(inventory.find(p=>p.path===other)).toMatchObject({readControl:"blocked_unselected",referenceStatus:"unverified_legacy",sourceRefsSHA256:publicationHash(publicationCanonical(partial))});
    expect(inventory.find(p=>p.path===kept)).toMatchObject({readControl:"blocked_by_retraction",referenceStatus:"unverified_legacy"});
    expect(inventory.find(p=>p.path==="wiki/p7.md")).toMatchObject({readControl:"retracted",referenceStatus:"pinned_registry"});
    expect(()=>inventoryRetractionPages([...rows,row],fence,noPriorHold)).toThrow(/inventory_duplicate/);
  });
  it("reports the prior strict hold even when the next fence marks that page readable",()=>{
    const p="wiki/p7.md",fence={folderKey:"wiki-root" as const,rootPath:"/synthetic",pathPrefix:"",mode:"citation-holds" as const,
      registeredPaths:[p],readable:[{path:p,contentHash:hash}],blocks:[]};
    const prior={block:(path:string)=>({path,state:"retracted" as const,retractionId:"old",retractedPath:p,reason:"Prior withdrawal",eventHash:hash})};
    expect(inventoryRetractionPages([{path:p,source_refs:[],content_hash:hash}],fence,prior)[0]).toMatchObject({readControl:"retracted",readPolicy:"strict"});
  });
  it("pins reference changes and refuses a changed file or missing reference array",async()=>{
    await expect(preserveExistingRetractionPages(pins,[{...row,content_hash:hash}],held,[kept],read,noPriorHold)).rejects.toThrow(/preserve_content_changed/);
    await expect(preserveExistingRetractionPages(pins,[{...row,source_refs:null}],held,[kept],read,noPriorHold)).rejects.toThrow(/preserve_metadata/);
    const a=await preserveExistingRetractionPages(pins,[row],held,[kept],read,noPriorHold);
    const b=await preserveExistingRetractionPages(pins,[{...row,source_refs:[...refs,{note:"new reference"}]}],held,[kept],read,noPriorHold);
    expect(a[0]!.sourceRefsSHA256).not.toBe(b[0]!.sourceRefsSHA256);
    expect(a[0]!.contentHash).toBe(b[0]!.contentHash);
  });
});
