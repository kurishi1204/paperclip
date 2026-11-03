import { assertWikiRootOwnership } from "../services/wiki-retraction-store.js";
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retractionFolderGate, canonicalWikiRetractionPath, readRetractionFolderText, readRetractionFolderTextWithStatus } from "../services/wiki-retraction-gate.js";
import { writePluginLocalFolderTextAtomic, createPluginLocalFolderTextExclusive, readPluginLocalFolderText } from "../services/plugin-local-folders.js";
import { executeRetraction, retractionEventHash, type RetractionStore, type RetractionEvent } from "../services/wiki-retraction-ledger.js";
import { publicationHash } from "../services/wiki-publication-readback.js";

async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "wiki-retraction-runtime-")));
  await mkdir(join(dir,"wiki"));
  const original = "A synthetic withdrawn assertion\n"; const upstream = "An unrelated upstream fact\n";
  await writeFile(join(dir, "wiki/target.md"), original); await writeFile(join(dir, "wiki/upstream.md"), upstream);
  let events: RetractionEvent[] = []; let queue = Promise.resolve();
  const locked = async <T>(work: () => Promise<T>) => {
    const previous = queue; let release!: () => void;
    queue = new Promise<void>(r => { release = r; }); await previous;
    try { return await work(); } finally { release(); }
  };
  const store: RetractionStore = { read: async () => structuredClone(events), transaction: (_scope, work) => locked(async () => {
    const staged = structuredClone(events);
    const result = await work({ events: async () => staged, append: async e => { staged.push(e); } }); events = staged; return result;
  }) };
  const target = { companyId: "c", wikiId: "default", spaceSlug: "default", path: "wiki/target.md", contentHash: publicationHash(original) };
  const withdraw = () => executeRetraction(store, { target, retractionId: "op", reason: "Incorrect assumption", actorId: "owner",
    runId: null, eventId: "e", at: "2026-11-03T02:00:00Z",
    approval: { id: "review", companyId: "c", target, reason: "Incorrect assumption", reviewerId: "qa", reviewRunId: "qa-run", ownerDecisionId: "op" },
    fence: { folderKey: "wiki-root", rootPath: dir, pathPrefix: "", mode: "freeze-wiki", readable: [{ path: "wiki/upstream.md", contentHash: publicationHash(upstream) }],
      blocks: [{ path: "wiki/target.md", contentHash: publicationHash(original), state: "retracted" }] },
    readCurrent: async () => ({ path: target.path, contentHash: publicationHash(await readFile(join(dir, "wiki/target.md"))) }) });
  const read = (path: string) => locked(async () => {
    const gate = retractionFolderGate(events, "c", "wiki-root"); gate.assertRead(path);
    const contents = await readFile(join(dir, path), "utf8"); gate.assertRead(path, contents); return contents;
  });
  const write = (path: string, contents: string) => locked(async () => {
    retractionFolderGate(events, "c", "wiki-root").assertWrite(path); await writeFile(join(dir, path), contents);
  });
  return { dir, original, upstream, withdraw, read, write, events: () => events,
    close: () => rm(dir, { recursive: true }) };
}

test("real file path: use -> withdraw -> tombstone; upstream stays usable and audit bytes survive", async () => {
  const f = await setup(); try {
    assert.equal(await f.read("wiki/target.md"), f.original);
    await f.withdraw();
    await assert.rejects(f.read("wiki/target.md"), /E_SOURCE_RETRACTED/);
    assert.equal(await f.read("wiki/upstream.md"), f.upstream);
    assert.equal(await readFile(join(f.dir, "wiki/target.md"), "utf8"), f.original);
    assert.equal(f.events().length, 1);
    // A new gate instance after restart still blocks; no publication config exists.
    assert.throws(() => retractionFolderGate(structuredClone(f.events()), "c", "wiki-root").assertRead("wiki/target.md"), /E_SOURCE_RETRACTED/);
  } finally { await f.close(); }
});
test("withdrawal and real writes share one barrier; a new alias cannot escape the snapshot", async () => {
  const f = await setup(); try {
    await Promise.all([f.withdraw(), f.write("wiki/copy.md", f.original).then(() => assert.fail("write passed"), e => assert.match(String(e), /WRITE_HOLD/))]);
    await assert.rejects(f.read("wiki/copy.md"), /E_SOURCE_RETRACTED/);
    await symlink(join(f.dir, "wiki/target.md"), join(f.dir, "wiki/alias.md"));
    await assert.rejects(f.read("wiki/alias.md"), /E_SOURCE_RETRACTED/);
    await assert.rejects(f.write("wiki/upstream.md", "changed"), /WRITE_HOLD/);
    assert.equal(await f.read("wiki/upstream.md"), f.upstream);
    await mkdir(join(f.dir,"raw"));
    await f.write("raw/new-capture.md","A fresh human original");
    assert.equal(await f.read("raw/new-capture.md"),"A fresh human original");
  } finally { await f.close(); }
});
test("changed allowlisted bytes and cross-company/corrupt receipts fail visibly", async () => {
  const f = await setup(); try {
    await f.withdraw(); await writeFile(join(f.dir, "wiki/upstream.md"), "changed outside host");
    await assert.rejects(f.read("wiki/upstream.md"), /readable_content_changed/);
    assert.throws(() => retractionFolderGate(f.events(), "another-company", "wiki-root"), /ledger_scope/);
    assert.throws(() => retractionFolderGate([{ ...f.events()[0]!, reason: "tampered" }], "c", "wiki-root"), /ledger_integrity/);
  } finally { await f.close(); }
});

test("new leaves under a raw directory alias cannot escape the actual Wiki write hold", async () => {
  const f = await setup(); try {
    await mkdir(join(f.dir, "raw"));
    await symlink(join(f.dir, "wiki"), join(f.dir, "raw/alias"));
    await f.withdraw();
    const gate = retractionFolderGate(f.events(), "c", "wiki-root");
    gate.assertRoot(f.dir);
    for (const [leaf, write] of [
      ["new.md", writePluginLocalFolderTextAtomic],
      ["exclusive.md", createPluginLocalFolderTextExclusive],
    ] as const) {
      const alias = `raw/alias/${leaf}`;
      assert.equal(await canonicalWikiRetractionPath(f.dir, alias), `wiki/${leaf}`);
      await assert.rejects((async () => {
        gate.assertWrite(alias);
        gate.assertWrite(await canonicalWikiRetractionPath(f.dir, alias));
        await write(f.dir, alias, "Unreviewed assertion");
      })(), /WRITE_HOLD/);
      await assert.rejects(readFile(join(f.dir, "wiki", leaf)), { code: "ENOENT" });
    }
    const fresh = "raw/captures/day/new.md";
    gate.assertWrite(await canonicalWikiRetractionPath(f.dir, fresh));
    await createPluginLocalFolderTextExclusive(f.dir, fresh, "Fresh original");
    assert.equal(await readPluginLocalFolderText(f.dir, fresh), "Fresh original");
    assert.equal(await readFile(join(f.dir, "wiki/target.md"), "utf8"), f.original);
  } finally { await f.close(); }
});
test("an active withdrawal keeps its recorded physical root; changing it cannot expose originals as raw", async () => {
  const f = await setup(); try {
    await f.withdraw();
    const gate = retractionFolderGate(f.events(), "c", "wiki-root");
    gate.assertRoot(f.dir);
    assert.throws(() => gate.assertRoot(join(f.dir, "raw")), /runtime_root_changed/);
    assert.throws(() => gate.assertRoot(join(f.dir, "..")), /runtime_root_changed/);
    assert.throws(() => gate.assertRoot(""), /runtime_root_changed/);
    retractionFolderGate([], "c", "wiki-root").assertRoot("another-root");
    assert.equal(await readFile(join(f.dir, "wiki/target.md"), "utf8"), f.original);
  } finally { await f.close(); }
});

test("citation reader preserves downstream bytes with invalid-reference marks; legacy reader stays strict", async () => {
  const f=await setup();try {
    await writeFile(join(f.dir,"wiki/child.md"),"Held citation plus an unrelated usable paragraph");
    await f.withdraw();
    const events=structuredClone(f.events());const e=events[0]!;
    e.fence!.mode="citation-holds";
    e.fence!.blocks.push({path:"wiki/child.md",contentHash:publicationHash("Held citation plus an unrelated usable paragraph"),state:"blocked_by_retraction"});
    const {eventHash:_,...basis}=e;e.eventHash=retractionEventHash(basis);
    const gate=retractionFolderGate(events,"c","wiki-root");
    const read=await readRetractionFolderTextWithStatus(f.dir,"wiki/child.md",gate);
    assert.equal(read.contents,"Held citation plus an unrelated usable paragraph");
    assert.equal(read.citationHolds[0]!.retractedPath,"wiki/target.md");
    assert.equal(read.citationHolds[0]!.readPolicy,"citation-holds");
    await assert.rejects(readRetractionFolderText(f.dir,"wiki/child.md",gate),/E_SOURCE_RETRACTED/);
    await assert.rejects(readRetractionFolderTextWithStatus(f.dir,"wiki/target.md",gate),/E_SOURCE_RETRACTED/);
    assert.equal((await readRetractionFolderTextWithStatus(f.dir,"wiki/upstream.md",gate)).contents,f.upstream);
    await mkdir(join(f.dir,"raw"));await symlink(join(f.dir,"wiki/target.md"),join(f.dir,"raw/alias.md"));
    await assert.rejects(readRetractionFolderTextWithStatus(f.dir,"raw/alias.md",gate),/E_SOURCE_RETRACTED/);
    assert.throws(()=>gate.assertWrite("wiki/new.md"),/WRITE_HOLD/);
    await writeFile(join(f.dir,"wiki/child.md"),"changed after the snapshot");
    await assert.rejects(readRetractionFolderTextWithStatus(f.dir,"wiki/child.md",gate),/readable_content_changed/);
    assert.equal(await readFile(join(f.dir,"wiki/target.md"),"utf8"),f.original);
  }finally{await f.close();}
});
test("citation-aware reader cannot weaken an old freeze fence",async()=>{
 const f=await setup();try{await f.withdraw();const gate=retractionFolderGate(f.events(),"c","wiki-root");
  await assert.rejects(readRetractionFolderTextWithStatus(f.dir,"wiki/target.md",gate),/E_SOURCE_RETRACTED/);
  await assert.rejects(readRetractionFolderTextWithStatus(f.dir,"wiki/not-registered.md",gate),/E_SOURCE_RETRACTED/);
 }finally{await f.close();}
});

test("company Wiki roots cannot share physical files through equal, nested or aliased roots",async()=>{
 const f=await setup();try{
  await mkdir(join(f.dir,"separate"));await mkdir(join(f.dir,"nested"));await symlink(f.dir,join(f.dir,"separate/alias"));
  let configured=f.dir;
  const db={select:()=>({from:()=>({where:async()=>[{companyId:"other-company",settingsJson:{localFolders:{"wiki-root":{path:configured}}}}]})})};
  for(const other of [f.dir,join(f.dir,"nested"),join(f.dir,"separate/alias")]){
   configured=other;await assert.rejects(assertWikiRootOwnership(db as any,"plugin","c",f.dir),/runtime_root_shared/);
  }
  configured=f.dir;await assert.rejects(assertWikiRootOwnership(db as any,"plugin","c",join(f.dir,"nested")),/runtime_root_shared/);
  // A distinct sibling stays usable. An absent nested path is already
  // claimed before creation and remains rejected after it exists.
  configured=join(f.dir,"nested/not-created");await assert.rejects(assertWikiRootOwnership(db as any,"plugin","c",f.dir),/runtime_root_shared/);
  await mkdir(configured);await assert.rejects(assertWikiRootOwnership(db as any,"plugin","c",f.dir),/runtime_root_shared/);
  configured=join(f.dir,"separate");await assertWikiRootOwnership(db as any,"plugin","c",join(f.dir,"nested"));
 }finally{await f.close();}
});
