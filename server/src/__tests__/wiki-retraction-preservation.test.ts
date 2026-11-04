import { mkdtemp,mkdir,readFile,rm,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe,it,expect } from "vitest";
import { executeRetraction,validateRetractionEvents,retractionEventHash,type RetractionEvent,type RetractionStore } from "../services/wiki-retraction-ledger.js";
import { retractionFolderGate,readRetractionFolderText } from "../services/wiki-retraction-gate.js";
import { preserveUnrelatedRetractionPages } from "../services/wiki-retraction-readback.js";
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
    const dir=await mkdtemp(join(tmpdir(),"wiki-preserved-page-"));
    try{
      await mkdir(join(dir,"wiki"));
      await writeFile(join(dir,kept),body);
      const measured=await preserveUnrelatedRetractionPages(pins,[row],held,[kept],async path=>({path,contents:await readFile(join(dir,kept),"utf8")}),noPriorHold);
      expect(measured).toEqual([{path:kept,contentHash:publicationHash(body),sourceRefsSHA256:publicationHash(publicationCanonical(refs))}]);
      expect(pins.some(pin=>pin.path===kept)).toBe(false);
      expect(await preserveUnrelatedRetractionPages(pins,[row],held,[],read,noPriorHold)).toEqual([]);
      expect(await readFile(join(dir,kept),"utf8")).toBe(body);
      const events:RetractionEvent[]=[];
      const store:RetractionStore={read:async()=>events,transaction:async(_scope,work)=>work({events:async()=>events,append:async e=>{events.push(e);}})};
      const target={companyId:"synthetic-company",wikiId:"default",spaceSlug:"default",path:"wiki/p7.md",contentHash:hash};
      const event=await executeRetraction(store,{target,retractionId:"synthetic-operation",eventId:"synthetic-event",
        reason:"Synthetic retained-page read",actorId:"synthetic-owner",runId:null,at:new Date().toISOString(),
        approval:{id:"synthetic-review",companyId:target.companyId,target,reason:"Synthetic retained-page read",
          reviewerId:"synthetic-qa",reviewRunId:"synthetic-run",ownerDecisionId:"synthetic-human"},
        fence:{folderKey:"wiki-root",rootPath:dir,pathPrefix:"",mode:"citation-holds",registeredPaths:[target.path],
          blocks:[{path:target.path,contentHash:hash,state:"retracted"}],readable:measured.map(({path,contentHash})=>({path,contentHash})),preservedPages:measured},
        readCurrent:async()=>target});
      const gate=retractionFolderGate(events,target.companyId,"wiki-root");
      expect(await readRetractionFolderText(dir,kept,gate)).toBe(body);
      await expect(readRetractionFolderText(dir,target.path,gate)).rejects.toThrow(/E_SOURCE_RETRACTED/);
      await writeFile(join(dir,"wiki/future.md"),"Not selected");
      await expect(readRetractionFolderText(dir,"wiki/future.md",gate)).rejects.toThrow(/E_SOURCE_RETRACTED/);
      const invalid=structuredClone(event);invalid.fence!.preservedPages![0]!.sourceRefsSHA256="invalid";
      const {eventHash:_old,...basis}=invalid;invalid.eventHash=retractionEventHash(basis);
      expect(()=>validateRetractionEvents(target,[invalid])).toThrow(/fence_preserved_page/);
      const registered=structuredClone(event);registered.fence!.registeredPaths!.push(kept);
      const {eventHash:_registered,...registeredBasis}=registered;registered.eventHash=retractionEventHash(registeredBasis);
      expect(()=>validateRetractionEvents(target,[registered])).toThrow(/fence_preserved_page/);
      // A later proposal cannot claim to preserve a page that an earlier
      // durable fence still refuses. The prior event remains immutable.
      const prior=structuredClone(event);prior.fence!.readable=[];delete prior.fence!.preservedPages;
      const {eventHash:_prior,...priorBasis}=prior;prior.eventHash=retractionEventHash(priorBasis);
      const priorGate=retractionFolderGate([prior],target.companyId,"wiki-root");
      expect(()=>priorGate.assertRead(kept,body)).toThrow(/E_SOURCE_RETRACTED/);
      await expect(preserveUnrelatedRetractionPages(pins,[row],held,[kept],read,priorGate)).rejects.toThrow(/E_SOURCE_RETRACTED/);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it("refuses missing, duplicate, registered and held selections",async()=>{
    await expect(preserveUnrelatedRetractionPages(pins,[row],held,[kept,kept],read,noPriorHold)).rejects.toThrow(/preserve_paths/);
    await expect(preserveUnrelatedRetractionPages(pins,[row],held,["wiki/absent.md"],read,noPriorHold)).rejects.toThrow(/preserve_metadata/);
    await expect(preserveUnrelatedRetractionPages(pins,[row],held,["wiki/upstream.md"],read,noPriorHold)).rejects.toThrow(/preserve_path/);
    await expect(preserveUnrelatedRetractionPages(pins,[row],held,["wiki/p7.md"],read,noPriorHold)).rejects.toThrow(/preserve_path/);
  });
  it("rejects affected references even inside an unfamiliar nested metadata shape",async()=>{
    const rows=[{...row,source_refs:[{kind:"new-format",arbitrary:{nested:["doc-p7"]}}]}];
    await expect(preserveUnrelatedRetractionPages(pins,rows,held,[kept],read,noPriorHold)).rejects.toThrow(/preserve_dependency/);
  });
  it("rejects a partial reference containing the withdrawn issue identity",async()=>{
    const rows=[{...row,source_refs:[{kind:"unknown-shape",nested:{issue:"issue-p7"}}]}];
    await expect(preserveUnrelatedRetractionPages(pins,rows,held,[kept],read,noPriorHold)).rejects.toThrow(/preserve_dependency/);
  });
  it("rejects a partial reference containing the withdrawn revision identity",async()=>{
    const rows=[{...row,source_refs:[{kind:"unknown-shape",nested:{revision:"revision-p7"}}]}];
    await expect(preserveUnrelatedRetractionPages(pins,rows,held,[kept],read,noPriorHold)).rejects.toThrow(/preserve_dependency/);
  });
  it("rejects body dependencies on held or unselected pages",async()=>{
    for(const link of ["p7.md","unreviewed.md"]){
      const contents=`[Input](${link})\n`,rows=[{...row,content_hash:publicationHash(contents)}];
      await expect(preserveUnrelatedRetractionPages(pins,rows,held,[kept],async path=>({path,contents}),noPriorHold)).rejects.toThrow(/preserve_body_dependency/);
    }
  });
  it("pins reference changes and refuses a changed file or missing reference array",async()=>{
    await expect(preserveUnrelatedRetractionPages(pins,[{...row,content_hash:hash}],held,[kept],read,noPriorHold)).rejects.toThrow(/preserve_content_changed/);
    await expect(preserveUnrelatedRetractionPages(pins,[{...row,source_refs:null}],held,[kept],read,noPriorHold)).rejects.toThrow(/preserve_metadata/);
    const a=await preserveUnrelatedRetractionPages(pins,[row],held,[kept],read,noPriorHold);
    const b=await preserveUnrelatedRetractionPages(pins,[{...row,source_refs:[...refs,{note:"new reference"}]}],held,[kept],read,noPriorHold);
    expect(a[0]!.sourceRefsSHA256).not.toBe(b[0]!.sourceRefsSHA256);
    expect(a[0]!.contentHash).toBe(b[0]!.contentHash);
  });
});
