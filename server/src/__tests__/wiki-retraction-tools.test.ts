import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerWikiTools, readWikiPage, writeWikiPage } from "../../../packages/plugins/plugin-llm-wiki/src/wiki/core.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { retractionFolderGate } from "../services/wiki-retraction-gate.js";
import { executeRetraction, type RetractionEvent, type RetractionStore } from "../services/wiki-retraction-ledger.js";
import { publicationHash } from "../services/wiki-publication-readback.js";

test("actual registered Wiki tools and UI page read stop withdrawn bodies and discovery snippets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wiki-tool-withdrawal-"));
  try {
    await mkdir(join(dir,"wiki"));
    const bodies: Record<string,string> = { "wiki/p7.md": "Withdrawn original", "wiki/child.md": "Derived original", "wiki/upstream.md": "Usable upstream" };
    for (const [p,b] of Object.entries(bodies)) await writeFile(join(dir,p),b);
    let events: RetractionEvent[] = [];
    const handlers = new Map<string, (input: unknown) => Promise<any>>();
    const allRows = Object.keys(bodies).map(p => ({ kind: "page", path: p, title: p === "wiki/upstream.md" ? "Usable" : "WITHDRAWN SNIPPET", page_type: "source", match_text: "source" }));
    const ctx = { manifest: {}, tools: { register: (name: string, _meta: unknown, handler: (input: unknown) => Promise<any>) => handlers.set(name,handler) },
      db: { namespace: "synthetic", execute: async () => ({ rowCount: 0 }), query: async (sql: string) => sql.includes("wiki_spaces") ? [] : allRows },
      localFolders: {
        status: async () => ({ wikiRetractions: { state: events.length ? "active" : "inactive" } }),
        readText: async (_c: string, _k: string, p: string) => { const gate = retractionFolderGate(events,"c","wiki-root"); gate.assertRead(p); const b=await readFile(join(dir,p),"utf8");gate.assertRead(p,b);return b; },
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
    await assert.rejects(readWikiPage(ctx,args),/E_SOURCE_RETRACTED/);
    await assert.rejects(writeWikiPage(ctx,{...args,path:"wiki/upstream.md",contents:"overwrite"}),/WRITE_HOLD/);
    assert.equal(await readFile(join(dir,"wiki/upstream.md"),"utf8"),bodies["wiki/upstream.md"]);
    assert.equal(await readFile(join(dir,"wiki/p7.md"),"utf8"),bodies["wiki/p7.md"]);
  } finally { await rm(dir,{recursive:true}); }
});
