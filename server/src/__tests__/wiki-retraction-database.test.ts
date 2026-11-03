import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { executeRetraction } from "../services/wiki-retraction-ledger.js";
import { loadAllWikiRetractions, wikiRetractionStore, withWikiRetractionLock } from "../services/wiki-retraction-store.js";
import { retractionFolderGate, readRetractionFolderText } from "../services/wiki-retraction-gate.js";
import { registerWikiTools, listPages } from "../../../packages/plugins/plugin-llm-wiki/src/wiki/core.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { publicationHash } from "../services/wiki-publication-readback.js";

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

});
