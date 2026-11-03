import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, agents, issues, documents, issueDocuments, issueThreadInteractions, heartbeatRuns, plugins, pluginConfig, pluginCompanySettings } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { executeRetraction } from "../services/wiki-retraction-ledger.js";
import { loadAllWikiRetractions, wikiRetractionStore, withWikiRetractionLock } from "../services/wiki-retraction-store.js";
import { retractionFolderGate, readRetractionFolderText } from "../services/wiki-retraction-gate.js";
import { registerWikiTools, listPages } from "../../../packages/plugins/plugin-llm-wiki/src/wiki/core.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { publicationHash, publicationCanonical, reviewBasis, type PublicationRegistry, type JsonObject } from "../services/wiki-publication-readback.js";

import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { pluginDatabaseService } from "../services/plugin-database.js";
import { wikiRetractionRuntime } from "../services/wiki-retraction-runtime.js";
import { wikiRepublicationRuntime } from "../services/wiki-republication-runtime.js";
import { encodeWikiRepublicationDraft } from "../services/wiki-republication.js";
import wikiManifest from "../../../packages/plugins/plugin-llm-wiki/src/manifest.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Wiki withdrawal SQL tests did not run: ${support.reason ?? "unsupported"}`);
if (process.env.CI && process.env.CI !== "false" && !support.supported) it("requires the real withdrawal SQL contract in CI", () => {
  throw new Error(`Withdrawal SQL contract did not run: ${support.reason ?? "unsupported"}`);
});

describeDatabase("durable Wiki withdrawal SQL and file boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let cluster: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const roots: string[] = [];
  beforeAll(async () => { cluster = await startEmbeddedPostgresTestDatabase("paperclip-wiki-withdrawal-"); db = createDb(cluster.connectionString); }, 90_000);
  afterAll(async () => { await cluster?.cleanup(); for (const root of roots) await rm(root, { recursive: true, force: true }); }, 90_000);
  async function fixture() {
    const companyId = randomUUID(); const pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic withdrawal company", issuePrefix: "W" + companyId.replaceAll("-","").slice(0,12) });
    const dir = await realpath(await mkdtemp(join(tmpdir(), "wiki-withdrawal-sql-"))); roots.push(dir);
    await mkdir(join(dir,"wiki"));
    const file = join(dir, "wiki/p7.md"); const body = "Synthetic original retained for audit\n"; await writeFile(file,body);
    const target = { companyId, wikiId: "default", spaceSlug: "default", path: "wiki/p7.md", contentHash: publicationHash(body) };
    const input = { target, retractionId: randomUUID(), reason: "Incorrect synthetic claim", actorId: "synthetic-owner", runId: null,
      eventId: randomUUID(), at: new Date().toISOString(),
      approval: { id: "synthetic-review", companyId, target, reason: "Incorrect synthetic claim", reviewerId: "synthetic-qa", reviewRunId: "synthetic-qa-run", ownerDecisionId: "synthetic-decision" },
      fence: { folderKey: "wiki-root" as const, rootPath: dir, pathPrefix: "", mode: "freeze-wiki" as const, readable: [], blocks: [{ path: target.path, contentHash: target.contentHash, state: "retracted" as const }] },
      readCurrent: async () => ({ path: target.path, contentHash: publicationHash(await readFile(file)) }) };
    return { companyId, pluginId, dir, file, body, target, input, store: wikiRetractionStore(db,pluginId) };
  }
  it("concurrent execution appends exactly one receipt that a new store reads back", async () => {
    const f = await fixture();
    const [a,b] = await Promise.all([executeRetraction(f.store,f.input),executeRetraction(f.store,{...f.input,eventId:randomUUID()})]);
    expect(a).toEqual(b);
    const rows = await loadAllWikiRetractions(db,f.pluginId,f.companyId);
    expect(rows).toHaveLength(1);
    expect(await wikiRetractionStore(db,f.pluginId).read(f.target)).toEqual(rows);
    expect(await readFile(f.file,"utf8")).toBe(f.body);
  });
  it("an actual audit INSERT failure rolls back the hold and retains original bytes", async () => {
    const f = await fixture();
    await db.insert(activityLog).values({id:f.input.eventId,companyId:f.companyId,actorType:"system",actorId:"fixture",action:"fixture.collision",entityType:"fixture",entityId:f.pluginId});
    await expect(executeRetraction(f.store,f.input)).rejects.toThrow();
    expect(await loadAllWikiRetractions(db,f.pluginId,f.companyId)).toEqual([]);
    expect(await readFile(f.file,"utf8")).toBe(f.body);
  });
  it("a queued real file write cannot cross the withdrawal commit barrier", async () => {
    const f = await fixture(); let acquired!: () => void; let release!: () => void;
    const atRead = new Promise<void>(r=>{acquired=r;}); const continueRead = new Promise<void>(r=>{release=r;});
    const withdrawal = executeRetraction(f.store,{...f.input,readCurrent:async()=>{acquired();await continueRead;return f.input.readCurrent();}});
    await atRead;
    const mutation = withWikiRetractionLock(db,f.pluginId,f.companyId,async tx=>{
      retractionFolderGate(await loadAllWikiRetractions(tx,f.pluginId,f.companyId),f.companyId,"wiki-root").assertWrite(f.target.path);
      await writeFile(f.file,"must not overwrite");
    });
    const rejected = expect(mutation).rejects.toThrow(/WRITE_HOLD/);
    release(); await withdrawal; await rejected;
    expect(await readFile(f.file,"utf8")).toBe(f.body);
    expect(await loadAllWikiRetractions(db,f.pluginId,f.companyId)).toHaveLength(1);
  });
  it("registered discovery and UI keep usable pages beyond held SQL windows", async () => {
    const f = await fixture(); const namespace = "withdrawal_window_" + randomUUID().replaceAll("-", "");
    const available = "wiki/z-upstream.md"; const usable = "A usable unrelated fact";
    await writeFile(join(f.dir, available), usable);
    await db.$client.unsafe(`CREATE SCHEMA ${namespace}`);
    try {
      await db.$client.unsafe(`CREATE TABLE ${namespace}.wiki_pages (
        company_id text, wiki_id text, space_id text, path text, title text, page_type text,
        backlinks jsonb, source_refs jsonb, content_hash text, updated_at timestamptz DEFAULT now(),
        UNIQUE(company_id,wiki_id,space_id,path))`);
      await db.$client.unsafe(`CREATE TABLE ${namespace}.wiki_sources (
        company_id text, wiki_id text, space_id text, raw_path text, title text, source_type text,
        url text, status text, content_hash text, created_at timestamptz DEFAULT now())`);
      await db.$client.unsafe(`INSERT INTO ${namespace}.wiki_pages
        SELECT $1,'default','space','wiki/a'||lpad(n::text,3,'0')||'.md','Held','source',
          '["wiki/parent.md"]'::jsonb,'[]'::jsonb,'synthetic',now() FROM generate_series(0,199) AS n`, [f.companyId]);
      await db.$client.unsafe(`INSERT INTO ${namespace}.wiki_pages VALUES
        ($1,'default','space',$2,'Held original','source','["wiki/parent.md"]'::jsonb,'[]'::jsonb,$3,now()),
        ($1,'default','space',$4,'Usable unrelated fact','source','["wiki/parent.md"]'::jsonb,'[]'::jsonb,$5,now())`,
        [f.companyId,f.target.path,f.target.contentHash,available,publicationHash(usable)]);
      await executeRetraction(f.store,{...f.input,fence:{...f.input.fence,
        readable:[{path:available,contentHash:publicationHash(usable)}]}});
      const handlers=new Map<string,(input:unknown)=>Promise<any>>();
      const ctx={manifest:{},tools:{register:(name:string,_meta:unknown,handler:(input:unknown)=>Promise<any>)=>handlers.set(name,handler)},
        db:{namespace,execute:async(q:string)=>{if(!q.includes("wiki_spaces"))throw new Error("unexpected read-journey mutation");return{rowCount:0};},
          query:async(q:string,args:unknown[]=[])=>q.includes("wiki_spaces")?[{id:"space",company_id:f.companyId,wiki_id:"default",slug:"default",display_name:"default",space_type:"local_folder",folder_mode:"managed_subfolder",root_folder_key:"wiki-root",path_prefix:null,access_scope:"shared",settings:{},status:"active"}]:[...await db.$client.unsafe(q,args as never[])]},
        localFolders:{status:async()=>({wikiRetractions:{state:"active"}}),readText:async(_c:string,_k:string,path:string)=>{
          const gate=retractionFolderGate(await loadAllWikiRetractions(db,f.pluginId,f.companyId),f.companyId,"wiki-root");
          return readRetractionFolderText(f.dir,path,gate);
        }}} as unknown as PluginContext;
      await registerWikiTools(ctx);
      const args={companyId:f.companyId,wikiId:"default",spaceSlug:"default",query:"wiki",path:"wiki/parent.md",limit:1};
      expect((await handlers.get("wiki_search")!(args)).data.results.map((r:{path:string})=>r.path)).toEqual([available]);
      expect((await handlers.get("wiki_list_pages")!(args)).data.pages.map((r:{path:string})=>r.path)).toEqual([available]);
      expect((await handlers.get("wiki_list_backlinks")!(args)).data.backlinks.map((r:{path:string})=>r.path)).toEqual([available]);
      expect((await listPages(ctx,{...args,pageType:"source",limit:1})).pages.map(r=>r.path)).toEqual([available]);
      expect(await readFile(f.file,"utf8")).toBe(f.body);
    } finally { await db.$client.unsafe(`DROP SCHEMA ${namespace} CASCADE`); }
  }, 30_000);

  it("republishes through the real runtime and preserves an unknown file effect without replay", async () => {
    const pluginId = randomUUID();
    await db.insert(plugins).values({id:pluginId,pluginKey:wikiManifest.id,packageName:wikiManifest.id,
      version:wikiManifest.version,manifestJson:wikiManifest,status:"ready"});
    const pluginDb=pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId,wikiManifest,fileURLToPath(new URL("../../../packages/plugins/plugin-llm-wiki/",import.meta.url)));
    const ns=await pluginDb.getRuntimeNamespace(pluginId);
    async function context(newPath:string) {
      const companyId=randomUUID(),author=randomUUID(),qa=randomUUID(),spaceId=randomUUID();
      await db.insert(companies).values({id:companyId,name:"Synthetic reviewed republication",issuePrefix:"R"+companyId.replaceAll("-","").slice(0,12)});
      await db.insert(agents).values([{id:author,companyId,name:"Responsible author"},{id:qa,companyId,name:"Independent reviewer"}]);
      const dir=await realpath(await mkdtemp(join(tmpdir(),"wiki-republication-sql-")));roots.push(dir);
      for(const rel of wikiManifest.localFolders![0]!.requiredDirectories??[])await mkdir(join(dir,rel),{recursive:true});
      for(const rel of wikiManifest.localFolders![0]!.requiredFiles??[])await writeFile(join(dir,rel),"Retained synthetic metadata\n");
      await db.insert(pluginCompanySettings).values({companyId,pluginId,settingsJson:{localFolders:{"wiki-root":{path:dir,access:"readWrite"}}}});
      await db.$client.unsafe(`INSERT INTO ${ns}.wiki_spaces(id,company_id,wiki_id,slug,display_name) VALUES($1,$2,'default','default','Synthetic')`,[spaceId,companyId]);
      async function reviewedDocument(key:string,body:string) {
        const issueId=randomUUID(),documentId=randomUUID(),revisionId=randomUUID(),reviewId=randomUUID(),runId=randomUUID();
        await db.insert(issues).values({id:issueId,companyId,title:"Synthetic "+key});
        await db.insert(documents).values({id:documentId,companyId,latestBody:body,latestRevisionId:revisionId,createdByAgentId:author,updatedByAgentId:author});
        await db.insert(issueDocuments).values({companyId,issueId,documentId,key});
        await db.insert(heartbeatRuns).values({id:runId,companyId,agentId:qa,status:"succeeded",finishedAt:new Date()});
        const [review]=await db.insert(issueThreadInteractions).values({id:reviewId,companyId,issueId,kind:"request_confirmation",status:"accepted",
          createdByAgentId:author,resolvedByAgentId:qa,resolvedByRunId:runId,result:{version:1,outcome:"accepted"},
          payload:{version:1,prompt:"Review this exact synthetic document",target:{type:"issue_document",issueId,documentId,key,revisionId}}}).returning();
        return {issueId,documentId,documentKey:key,revisionId,reviewId,body,review:review!};
      }
      const registry:PublicationRegistry={schema:"colo.shared-wiki-publication-readback/v1",companyId,wikiId:"default",spaceSlug:"default",qaAgentId:qa,entries:[]};
      const sourceDocs=new Map<string,Awaited<ReturnType<typeof reviewedDocument>>>();
      for(const name of ["p7","child","upstream"]){
        const pagePath=`wiki/${name}.md`,body="# "+name+"\n\nSynthetic retained claim.\n",doc=await reviewedDocument(name,body);sourceDocs.set(name,doc);
        const ref=(d:typeof doc)=>({kind:"document",issueId:d.issueId,documentId:d.documentId,documentKey:d.documentKey,revisionId:d.revisionId});
        const refs=[ref(doc),...(name==="child"?[ref(sourceDocs.get("p7")!)]:[])];
        const hash=publicationHash(body);await writeFile(join(dir,pagePath),body);
        registry.entries.push({path:pagePath,issueId:doc.issueId,documentId:doc.documentId,documentKey:name,revisionId:doc.revisionId,producerAgentId:author,
          reviewId:doc.reviewId,wikiSHA256:hash,documentBodySHA256:hash,reviewRecordSHA256:publicationHash(publicationCanonical(reviewBasis(doc.review as unknown as JsonObject))),sourceRefsSHA256:publicationHash(publicationCanonical(refs))});
        await db.$client.unsafe(`INSERT INTO ${ns}.wiki_pages(id,company_id,wiki_id,space_id,path,page_type,source_refs,content_hash)
          VALUES($1,$2,'default',$3,$4,'source',$5::jsonb,$6)`,[randomUUID(),companyId,spaceId,pagePath,JSON.stringify(refs),hash]);
      }
      await db.insert(pluginConfig).values({pluginId,companyId,configJson:{publicationReadback:registry,syntheticPreservedSetting:true}});
      const target={companyId,wikiId:"default",spaceSlug:"default",path:"wiki/p7.md",contentHash:registry.entries[0]!.wikiSHA256};
      const preview=await wikiRetractionRuntime(db,pluginId).preview(target,target.path,"Synthetic revalidation");
      // Matching registry metadata cannot hide a different stored creator.
      await db.update(documents).set({createdByAgentId:qa}).where(eq(documents.id,registry.entries[0]!.documentId));
      await expect(wikiRetractionRuntime(db,pluginId).preview(target,target.path,"Synthetic revalidation")).rejects.toThrow(/published_source_identity/);
      await db.update(documents).set({createdByAgentId:author}).where(eq(documents.id,registry.entries[0]!.documentId));
      expect(preview.fence.mode).toBe("citation-holds");
      const withdrawal=await executeRetraction(wikiRetractionStore(db,pluginId),{target,retractionId:randomUUID(),reason:"Synthetic revalidation",actorId:"synthetic-owner",runId:null,eventId:randomUUID(),at:new Date().toISOString(),
        approval:{id:randomUUID(),companyId,target,reason:"Synthetic revalidation",reviewerId:qa,reviewRunId:randomUUID(),ownerDecisionId:randomUUID()},
        fence:preview.fence,readCurrent:async()=>target});
      const body=encodeWikiRepublicationDraft({companyId,wikiId:"default",spaceSlug:"default",retractionId:withdrawal.retractionId,previousPath:"wiki/child.md",path:newPath,
        reason:"Responsible author checked current evidence",dependencies:[{path:"wiki/upstream.md",wikiSHA256:registry.entries[2]!.wikiSHA256}]},"# Revalidated conclusion\n\nUse current independent evidence.\n");
      const draft=await reviewedDocument("revalidated",body);
      return {companyId,dir,body,newPath,registry,input:{companyId,issueId:draft.issueId,documentKey:draft.documentKey,reviewId:draft.reviewId,operationId:randomUUID(),actorId:"synthetic-owner"}};
    }
    const runtime=wikiRepublicationRuntime(db,pluginId),f=await context("wiki/revalidated.md");
    const original=await readFile(join(f.dir,"wiki/child.md"));
    const result=await runtime.execute(f.input);expect(result.type).toBe("republished");
    expect((await runtime.receipt(f.companyId,f.input.operationId)).state).toBe("published");
    expect((await runtime.execute(f.input)).id).toBe(result.id);
    const events=await loadAllWikiRetractions(db,pluginId,f.companyId),gate=retractionFolderGate(events,f.companyId,"wiki-root");
    expect(events).toHaveLength(2);expect(await readRetractionFolderText(f.dir,f.newPath,gate)).toBe(f.body);
    expect(await readFile(join(f.dir,"wiki/child.md"))).toEqual(original);
    await expect(readRetractionFolderText(f.dir,"wiki/p7.md",gate)).rejects.toThrow(/E_SOURCE_RETRACTED/);
    const [config]=await db.select().from(pluginConfig).where(eq(pluginConfig.companyId,f.companyId));
    expect(config!.configJson.syntheticPreservedSetting).toBe(true);
    expect((config!.configJson.publicationReadback as PublicationRegistry).entries).toHaveLength(4);
    expect(await db.$client.unsafe(`SELECT * FROM ${ns}.wiki_page_revisions WHERE company_id=$1`,[f.companyId])).toHaveLength(1);

    // Fail after the actual immutable file effect, inside the metadata transaction.
    const bad=await context("wiki/fault-after-file.md");
    await db.$client.unsafe(`CREATE FUNCTION ${ns}.reject_synthetic_republication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic metadata failure'; END $$`);
    await db.$client.unsafe(`CREATE TRIGGER reject_synthetic_republication BEFORE INSERT ON ${ns}.wiki_pages FOR EACH ROW WHEN (NEW.path='wiki/fault-after-file.md') EXECUTE FUNCTION ${ns}.reject_synthetic_republication()`);
    try {
      await expect(runtime.execute(bad.input)).rejects.toThrow(/synthetic metadata failure/);
      expect(await readFile(join(bad.dir,bad.newPath),"utf8")).toBe(bad.body);
      const receipt=await runtime.receipt(bad.companyId,bad.input.operationId);
      expect(receipt).toMatchObject({state:"prepared_or_unknown",automaticRetryAllowed:false,file:{present:true,matchesIntent:true}});
      await expect(runtime.execute(bad.input)).rejects.toThrow(/do not resend/);
      const badEvents=await loadAllWikiRetractions(db,pluginId,bad.companyId);expect(badEvents).toHaveLength(1);
      await expect(readRetractionFolderText(bad.dir,bad.newPath,retractionFolderGate(badEvents,bad.companyId,"wiki-root"))).rejects.toThrow(/E_SOURCE_RETRACTED/);
      expect(await db.$client.unsafe(`SELECT * FROM ${ns}.wiki_pages WHERE company_id=$1 AND path=$2`,[bad.companyId,bad.newPath])).toHaveLength(0);
      const [badConfig]=await db.select().from(pluginConfig).where(eq(pluginConfig.companyId,bad.companyId));
      expect((badConfig!.configJson.publicationReadback as PublicationRegistry).entries).toHaveLength(3);
    } finally {
      await db.$client.unsafe(`DROP TRIGGER reject_synthetic_republication ON ${ns}.wiki_pages`);
      await db.$client.unsafe(`DROP FUNCTION ${ns}.reject_synthetic_republication()`);
    }
  }, 60_000);

});
