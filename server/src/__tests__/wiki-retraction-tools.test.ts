import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerWikiTools, readWikiPage, writeWikiPage, listPages, listSources } from "../../../packages/plugins/plugin-llm-wiki/src/wiki/core.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { retractionFolderGate, canonicalWikiRetractionPath } from "../services/wiki-retraction-gate.js";
import { executeRetraction, type RetractionEvent, type RetractionStore } from "../services/wiki-retraction-ledger.js";
import { listPluginLocalFolderEntries } from "../services/plugin-local-folders.js";
import { publicationHash } from "../services/wiki-publication-readback.js";

test("actual registered Wiki tools and UI page read stop withdrawn bodies and discovery snippets", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "wiki-tool-withdrawal-")));
  try {
    await mkdir(join(dir,"wiki"));
    const bodies: Record<string,string> = { "wiki/p7.md": "Withdrawn original", "wiki/child.md": "Derived original", "wiki/upstream.md": "Usable upstream" };
    for (const [p,b] of Object.entries(bodies)) await writeFile(join(dir,p),b);
    let events: RetractionEvent[] = [];
    const handlers = new Map<string, (input: unknown) => Promise<any>>();
    const allRows = Object.keys(bodies).map(p => ({ kind: "page", path: p, title: p === "wiki/upstream.md" ? "Usable" : "WITHDRAWN SNIPPET", page_type: "source", match_text: "source" }));
    const sourceRows: Array<Record<string, unknown>> = [];
    let queryWindowCalls=0;
    const ctx = { manifest: {}, tools: { register: (name: string, _meta: unknown, handler: (input: unknown) => Promise<any>) => handlers.set(name,handler) },
      db: { namespace: "synthetic", execute: async () => ({ rowCount: 0 }), query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("wiki_spaces")) return [];
        const sources = sourceRows.map(row => sql.includes("UNION ALL") ? { ...row, kind: "source", path: row.raw_path, match_text: row.source_type } : row);
        const rows = sql.includes("UNION ALL") ? [...allRows,...sources].sort((a,b) => `${a.kind}:${a.path}`.localeCompare(`${b.kind}:${b.path}`))
          : sql.includes("wiki_sources") ? sources : [...allRows].sort((a,b)=>a.path.localeCompare(b.path));
        // Model only SQL's ordinary LIMIT/OFFSET primitive, not the withdrawal filter.
        const bound = (token: string | undefined, fallback: number) => token ? token.startsWith("$") ? Number(params[Number(token.slice(1))-1]) : Number(token) : fallback;
        const limit = bound(sql.match(/LIMIT\s+(\$\d+|\d+)/i)?.[1], rows.length);
        const offset = bound(sql.match(/OFFSET\s+(\$\d+|\d+)/i)?.[1], 0);
        queryWindowCalls++;return rows.slice(offset,offset+limit);
      } },
      localFolders: {
        status: async () => ({ wikiRetractions: { state: events.length ? "active" : "inactive" } }),
        readText: async (_c: string, _k: string, p: string) => { const gate = retractionFolderGate(events,"c","wiki-root"); gate.assertRoot(dir); gate.assertRead(p); const physical=await canonicalWikiRetractionPath(dir,p);gate.assertRead(physical);const b=await readFile(join(dir,p),"utf8");gate.assertRead(physical,b);return b; },
        writeTextAtomic: async (_c: string, _k: string, p: string,b: string) => { retractionFolderGate(events,"c","wiki-root").assertWrite(p); await writeFile(join(dir,p),b); },
      },
    } as unknown as PluginContext;
    await registerWikiTools(ctx);
    const args={companyId:"c",wikiId:"default",spaceSlug:"default",path:"wiki/p7.md",query:"fact"};
    assert.equal((await handlers.get("wiki_read_page")!(args)).content,bodies["wiki/p7.md"]);
    const target={companyId:"c",wikiId:"default",spaceSlug:"default",path:"wiki/p7.md",contentHash:publicationHash(bodies["wiki/p7.md"]!)};
    const store: RetractionStore={read:async()=>events,transaction:async(_scope,work)=>work({events:async()=>events,append:async e=>{events.push(e);}})};
    await executeRetraction(store,{target,retractionId:"op",reason:"Outdated",actorId:"owner",runId:null,eventId:"e",at:"2026-11-03T02:00:00Z",
      approval:{id:"qa",companyId:"c",target,reason:"Outdated",reviewerId:"reviewer",reviewRunId:"r",ownerDecisionId:"op"},
      fence:{folderKey:"wiki-root",rootPath:dir,pathPrefix:"",mode:"freeze-wiki",blocks:[{path:"wiki/p7.md",contentHash:target.contentHash,state:"retracted"},{path:"wiki/child.md",contentHash:publicationHash(bodies["wiki/child.md"]!),state:"blocked_by_retraction"}],readable:[{path:"wiki/upstream.md",contentHash:publicationHash(bodies["wiki/upstream.md"]!)}]},
      readCurrent:async()=>({path:"wiki/p7.md",contentHash:target.contentHash})});
    const result=await handlers.get("wiki_read_page")!(args);
    assert.equal(result.data.publicationReadback.state,"retracted");
    assert.equal(JSON.stringify(result).includes(bodies["wiki/p7.md"]!),false);
    for (const tool of ["wiki_search","wiki_list_pages","wiki_list_backlinks"]) {
      const output=await handlers.get(tool)!(args);
      assert.equal(output.data.retractionReadback.hiddenCount,2);
      assert.equal(JSON.stringify(output).includes("WITHDRAWN SNIPPET"),false);
      assert.match(output.content,/Usable/);
    }
    // More held rows than the tool's SQL page size must not hide a usable page.
    for (let i=0;i<200;i++) allRows.push({kind:"page",path:`wiki/a${String(i).padStart(3,"0")}.md`,title:"WITHDRAWN SNIPPET",page_type:"source",match_text:"source"});
    const first = await handlers.get("wiki_search")!({...args,limit:1});
    assert.deepEqual(first.data.results.map((row: {path:string})=>row.path),["wiki/upstream.md"]);
    for (const tool of ["wiki_list_pages","wiki_list_backlinks"]) {
      const result=await handlers.get(tool)!(args);
      const rows=tool==="wiki_list_pages"?result.data.pages:result.data.backlinks;
      assert.deepEqual(rows.map((row: {path:string})=>row.path),["wiki/upstream.md"]);
    }
    assert.deepEqual((await listPages(ctx,{...args,pageType:"source",limit:1})).pages.map(row=>row.path),["wiki/upstream.md"]);
    await mkdir(join(dir,"raw"));await symlink(join(dir,"wiki/p7.md"),join(dir,"raw/a-held.md"));
    await writeFile(join(dir,"raw/z-upstream.md"),"Available raw original");
    sourceRows.push({raw_path:"raw/a-held.md",title:"Held alias",source_type:"manual",url:null,status:"captured",created_at:"2026-11-03"},
      {raw_path:"raw/z-upstream.md",title:"Available raw original",source_type:"manual",url:null,status:"captured",created_at:"2026-11-03"});
    assert.deepEqual((await handlers.get("wiki_list_sources")!({...args,limit:1})).data.sources.map((row:{raw_path:string})=>row.raw_path),["raw/z-upstream.md"]);
    assert.deepEqual((await listSources(ctx,{...args,limit:1,onlyReadable:true})).sources.map(row=>row.rawPath),["raw/z-upstream.md"]);
    // The worker's sources data handler omits onlyReadable: its default must
    // still exclude held metadata, while inactive ordinary metadata stays usable.
    expect.soft((await listSources(ctx,{...args,limit:1})).sources.map(row=>row.rawPath)).toEqual(["raw/z-upstream.md"]);
    await writeFile(join(dir,"raw/zz-unindexed.md"),"Usable unindexed raw file");
    const rawWindow=await listPluginLocalFolderEntries(dir,{relativePath:"raw",recursive:true,maxEntries:1});
    assert.equal(rawWindow.truncated,true);assert.equal(rawWindow.entries[0]?.path,"raw/a-held.md");
    // The real walker has hit its bound before the host removes the held alias.
    // Preserve that observed incomplete state at the UI's list boundary.
    (ctx.localFolders as unknown as {list:()=>Promise<unknown>}).list=async()=>({...rawWindow,entries:[]});
    await expect.soft(listPages(ctx,{...args,pageType:"source",includeRaw:true,limit:1})).rejects.toThrow(/E_WIKI_LOCAL_SCAN_INCOMPLETE/);

    // Exhaustion must be reported, never disguised as an empty complete search.
    for(let i=0;i<2001;i++)allRows.push({kind:"page",path:`wiki/000-cap-${String(i).padStart(4,"0")}.md`,title:"WITHDRAWN SNIPPET",page_type:"source",match_text:"source"});
    queryWindowCalls=0;
    await assert.rejects(handlers.get("wiki_search")!({...args,limit:1}),/E_WIKI_RETRACTION_SCAN_INCOMPLETE.*scanned=2000/);
    assert.ok(queryWindowCalls<100,`A one-result request must not cause one SQL round trip per held row: ${queryWindowCalls}`);
    await assert.rejects(readWikiPage(ctx,args),/E_SOURCE_RETRACTED/);
    await assert.rejects(writeWikiPage(ctx,{...args,path:"wiki/upstream.md",contents:"overwrite"}),/WRITE_HOLD/);
    assert.equal(await readFile(join(dir,"wiki/upstream.md"),"utf8"),bodies["wiki/upstream.md"]);
    assert.equal(await readFile(join(dir,"wiki/p7.md"),"utf8"),bodies["wiki/p7.md"]);
  } finally { await rm(dir,{recursive:true}); }
});
