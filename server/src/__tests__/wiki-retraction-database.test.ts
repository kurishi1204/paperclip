import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { executeRetraction } from "../services/wiki-retraction-ledger.js";
import { loadAllWikiRetractions, wikiRetractionStore, withWikiRetractionLock } from "../services/wiki-retraction-store.js";
import { retractionFolderGate } from "../services/wiki-retraction-gate.js";
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
    const dir = await mkdtemp(join(tmpdir(), "wiki-withdrawal-sql-")); roots.push(dir);
    await mkdir(join(dir,"wiki"));
    const file = join(dir, "wiki/p7.md"); const body = "Synthetic original retained for audit\n"; await writeFile(file,body);
    const target = { companyId, wikiId: "default", spaceSlug: "default", path: "wiki/p7.md", contentHash: publicationHash(body) };
    const input = { target, retractionId: randomUUID(), reason: "Incorrect synthetic claim", actorId: "synthetic-owner", runId: null,
      eventId: randomUUID(), at: new Date().toISOString(),
      approval: { id: "synthetic-review", companyId, target, reason: "Incorrect synthetic claim", reviewerId: "synthetic-qa", reviewRunId: "synthetic-qa-run", ownerDecisionId: "synthetic-decision" },
      fence: { folderKey: "wiki-root" as const, rootPath: dir, pathPrefix: "", mode: "freeze-wiki" as const, readable: [], blocks: [{ path: target.path, contentHash: target.contentHash, state: "retracted" as const }] },
      readCurrent: async () => ({ path: target.path, contentHash: publicationHash(await readFile(file)) }) };
    return { companyId, pluginId, file, body, target, input, store: wikiRetractionStore(db,pluginId) };
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
});
