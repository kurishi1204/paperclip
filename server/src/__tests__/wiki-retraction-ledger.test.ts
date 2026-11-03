import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRetraction, readRetractions, retractionBlock, validateRetractionEvents,
  type RetractionEvent, type RetractionScope, type RetractionStore } from "../services/wiki-retraction-ledger.js";
import { applyWikiPublicationReadback, publicationCanonical, publicationHash,
  type JsonObject, type PublicationRegistry } from "../services/wiki-publication-readback.js";
import { buildRetractionGraph, filterRetractedWikiResults, assertNoUnregisteredRetractionDependants } from "../services/wiki-retraction-readback.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "wiki-retraction-"));
  const body = "Synthetic published Wiki body\n"; const page = join(dir, "page.md");
  const journal = join(dir, "events.json"); await writeFile(page, body); await writeFile(journal, "[]");
  const scope: RetractionScope = { companyId: "company", wikiId: "default", spaceSlug: "default" };
  const target = { ...scope, path: "wiki/syntheses/p7.md", contentHash: publicationHash(body) };
  let failAudit = false; let commits = 0; let lock = Promise.resolve();
  const load = async () => JSON.parse(await readFile(journal, "utf8")) as RetractionEvent[];
  const store: RetractionStore = {
    read: load,
    transaction: async (_scope, work) => {
      const prior = lock; let release!: () => void;
      lock = new Promise<void>(resolve => { release = resolve; }); await prior;
      try {
        const staged = await load();
        const result = await work({ events: async () => structuredClone(staged), append: async event => {
          if (failAudit) throw new Error("audit unavailable"); staged.push(structuredClone(event));
        } });
        await writeFile(journal + ".next", JSON.stringify(staged)); await rename(journal + ".next", journal); commits++;
        return result;
      } finally { release(); }
    },
  };
  const input = { target, retractionId: "withdrawal-1", reason: "Superseded business assumption",
    actorId: "operator", runId: null, eventId: "event-1", at: "2026-11-03T01:00:00.000Z",
    approval: { id: "independent-review-1", companyId: scope.companyId, target,
      reason: "Superseded business assumption", reviewerId: "qa", reviewRunId: "qa-run", ownerDecisionId: "owner-request-1" },
    readCurrent: async () => ({ path: target.path, contentHash: publicationHash(await readFile(page)) }),
  };
  return { dir, page, journal, scope, target, input, store, load, commits: () => commits,
    failAudit: () => { failAudit = true; }, close: () => rm(dir, { recursive: true }) };
}

test("withdrawal survives a new reader and preserves the real file bytes", async () => {
  const f = await fixture(); try {
    const before = await readFile(f.page); const receipt = await executeRetraction(f.store, f.input);
    const restarted: RetractionStore = { ...f.store, read: async () => JSON.parse(await readFile(f.journal, "utf8")) };
    assert.deepEqual(await readRetractions(restarted, f.scope), [receipt]);
    assert.deepEqual(await readFile(f.page), before);
    assert.equal(receipt.sequence, 1); assert.equal(receipt.previousHash, null);
  } finally { await f.close(); }
});
test("changed source, wrong company, and self approval have no audit or file effect", async () => {
  const f = await fixture(); try {
    await writeFile(f.page, "changed");
    await assert.rejects(executeRetraction(f.store, f.input), /page_changed/);
    await assert.rejects(executeRetraction(f.store, { ...f.input, approval: { ...f.input.approval, companyId: "another" } }), /approval_scope/);
    await assert.rejects(executeRetraction(f.store, { ...f.input, actorId: "qa" }), /independent_approval/);
    assert.deepEqual(await f.load(), []); assert.equal(f.commits(), 0); assert.equal(await readFile(f.page, "utf8"), "changed");
  } finally { await f.close(); }
});
test("audit failure does not produce a withdrawal state", async () => {
  const f = await fixture(); try {
    f.failAudit(); await assert.rejects(executeRetraction(f.store, f.input), /audit unavailable/);
    assert.deepEqual(await readRetractions(f.store, f.scope), []); assert.equal(f.commits(), 0);
  } finally { await f.close(); }
});
test("concurrent receipt readback creates one event; a new body cannot revive its path", async () => {
  const f = await fixture(); try {
    const [a, b] = await Promise.all([executeRetraction(f.store, f.input), executeRetraction(f.store, { ...f.input, eventId: "event-2" })]);
    assert.deepEqual(a, b); assert.equal((await f.load()).length, 1);
    await writeFile(f.page, "new bytes");
    const target = { ...f.target, contentHash: publicationHash("new bytes") };
    await assert.rejects(executeRetraction(f.store, { ...f.input, target,
      approval: { ...f.input.approval, target }, retractionId: "withdrawal-2", eventId: "event-2" }), /already_retracted/);
    assert.equal((await f.load()).length, 1);
  } finally { await f.close(); }
});
test("audit corruption is an error rather than an empty healthy ledger", async () => {
  const f = await fixture(); try {
    const receipt = await executeRetraction(f.store, f.input);
    const altered = { ...receipt, reason: "silently changed" };
    assert.throws(() => validateRetractionEvents(f.scope, [altered]), /ledger_integrity/);
    assert.throws(() => validateRetractionEvents({ ...f.scope, companyId: "another" }, [receipt]), /ledger_scope/);
  } finally { await f.close(); }
});

test("one withdrawal blocks four direct and two indirect citations; the upstream parent stays usable", async () => {
  const f = await fixture(); try {
    const event = await executeRetraction(f.store, f.input);
    const graph = new Map<string, string[]>([["p3", []], [f.target.path, ["p3"]],
      ["a", [f.target.path]], ["b", [f.target.path]], ["c", [f.target.path]], ["d", [f.target.path]],
      ["e", ["a", "b"]], ["f", ["b"]], ["unrelated", []]]);
    const before = [...graph.keys()];
    const after = before.filter(path => !retractionBlock(path, graph, [event]));
    assert.deepEqual(after, ["p3", "unrelated"]);
    const blocked = before.filter(path => retractionBlock(path, graph, [event]));
    assert.deepEqual(blocked, [f.target.path, "a", "b", "c", "d", "e", "f"]);
    assert.equal(before.length - after.length, blocked.length);
    assert.equal(retractionBlock("e", graph, [event])?.state, "blocked_by_retraction");
    assert.equal(retractionBlock(f.target.path, graph, [event])?.state, "retracted");
  } finally { await f.close(); }
});

test("the existing publication reader returns a tombstone without the old body or citations", async () => {
  const f = await fixture(); try {
    const scope = f.scope; const registry: PublicationRegistry = { schema: "colo.shared-wiki-publication-readback/v1",
      ...scope, qaAgentId: "qa", entries: [] };
    const pages: Record<string, JsonObject> = {}, documents: Record<string, JsonObject> = {}, reviews: Record<string, JsonObject> = {};
    const add = (name: string, parents: string[]) => {
      const ref = { kind: "document", issueId: name, documentId: "doc-" + name, documentKey: name, revisionId: "rev-" + name };
      const body = "body-" + name; const review: JsonObject = { id: "qa-" + name, companyId: "company", issueId: name,
        status: "accepted", sourceRunId: "writer-run", resolvedByAgentId: "qa", resolvedByRunId: "qa-run",
        resolvedAt: null, payload: {}, result: { outcome: "accepted" } };
      documents[name] = { id: ref.documentId, ...scope, issueId: name, latestRevisionId: ref.revisionId, body,createdByAgentId:"writer",updatedByAgentId:"writer",updatedByUserId:null };
      reviews[name] = review; pages[name] = { path: name, ...scope, contents: body, hash: publicationHash(body),
        sourceRefs: [ref, ...parents.map(p => (pages[p]!.sourceRefs as JsonObject[])[0])] };
      registry.entries.push({ path: name, ...ref, producerAgentId: "writer", reviewId: review.id as string,
        wikiSHA256: publicationHash(body), documentBodySHA256: publicationHash(body),
        reviewRecordSHA256: publicationHash(publicationCanonical(review)), sourceRefsSHA256: publicationHash(publicationCanonical(pages[name]!.sourceRefs)) });
    };
    const source = f.target.path;
    add(source, []); add("dependent", [source]);
    const readers = { page: async (p: string) => pages[p]!, document: async (p: string) => documents[p]!, review: async (p: string) => ({...reviews[p]!,resolvedRun:{id:reviews[p]!.resolvedByRunId,companyId:"company",agentId:"qa",status:"succeeded"}}),
      retraction: async (p: string) => retractionBlock(p, new Map(), events) };
    let events: RetractionEvent[] = [];
    const run = (path: string) => applyWikiPublicationReadback(registry, "company", { companyId: "company", path },
      { content: pages[path]!.contents, data: { ...pages[path], privateCopy: pages[path]!.contents } }, readers);
    assert.equal((await run("dependent")).content, "body-dependent");
    // This trusted reader fixture represents the host store, not caller parameters.
    await executeRetraction(f.store, f.input);
    events = await readRetractions(f.store, f.scope);
    const output = await run("dependent");
    assert.equal((output.data as JsonObject).privateCopy, undefined);
    const proof = (output.data as JsonObject).publicationReadback as JsonObject;
    assert.equal(proof.state, "blocked_by_retraction"); assert.equal(proof.retractionId, "withdrawal-1");
    assert.ok(!JSON.stringify(output).includes("body-" + source) && !JSON.stringify(output).includes("body-dependent"));
    assert.equal(pages[source]!.contents, "body-" + source);
    // Removing a publication pin must not turn a withdrawal into an ordinary
    // unregistered read that exposes the preserved body again.
    registry.entries = registry.entries.filter(pin => pin.path !== source);
    const direct = await run(source);
    assert.equal(((direct.data as JsonObject).publicationReadback as JsonObject).state, "retracted");
    assert.ok(!JSON.stringify(direct).includes("body-" + source));
  } finally { await f.close(); }
});

test("search, page listing and backlinks omit both withdrawn and dependent snippets", async () => {
  const f = await fixture(); try {
    const event = await executeRetraction(f.store, f.input);
    const registry: PublicationRegistry = { schema: "colo.shared-wiki-publication-readback/v1", ...f.scope, qaAgentId: "qa", entries: [] };
    const pages: Record<string, JsonObject> = {};
    const add = (path: string, parents: string[]) => {
      const ref = { kind: "document", issueId: path, documentId: "doc-" + path, documentKey: path, revisionId: "r1" };
      pages[path] = { ...f.scope, path, sourceRefs: [ref, ...parents.map(p => (pages[p]!.sourceRefs as JsonObject[])[0])] };
      registry.entries.push({ path, ...ref, producerAgentId: "producer", reviewId: "review", wikiSHA256: "a".repeat(64),
        documentBodySHA256: "b".repeat(64), reviewRecordSHA256: "c".repeat(64), sourceRefsSHA256: publicationHash(publicationCanonical(pages[path]!.sourceRefs)) });
    };
    add("parent-p3", []); add(f.target.path, ["parent-p3"]); add("direct", [f.target.path]); add("indirect", ["direct"]);
    const graph = await buildRetractionGraph(registry, async p => pages[p]!);
    for (const [tool, field] of [["wiki_search", "results"], ["wiki_list_pages", "pages"], ["wiki_list_backlinks", "backlinks"]]) {
      const rows = [...graph.keys()].map(path => ({ path, title: path === "parent-p3" ? "active" : "withdrawn snippet" }));
      const output = filterRetractedWikiResults(tool!, registry, { content: "withdrawn snippet", data: { ...f.scope, [field!]: rows } }, graph, [event]);
      assert.deepEqual((output.data as JsonObject)[field!], [rows[0]]);
      assert.ok(!String(output.content).includes("withdrawn snippet"));
      assert.equal(((output.data as JsonObject).retractionReadback as JsonObject).hiddenCount, 3);
    }
    (pages.direct!.sourceRefs as unknown[]).pop();
    await assert.rejects(buildRetractionGraph(registry, async p => pages[p]!), /retraction_references_changed/);
  } finally { await f.close(); }
});

test("unregistered references block only affected document versions, including indirect holds", () => {
  const a = { path: "wiki/a.md", issueId: "a", documentId: "doc-a", documentKey: "body", revisionId: "a-v1" };
  const b = { path: "wiki/b.md", issueId: "b", documentId: "doc-b", documentKey: "body", revisionId: "b-v1" };
  const ref = (pin: typeof a) => ({ kind: "document", issueId: pin.issueId, documentId: pin.documentId,
    documentKey: pin.documentKey, revisionId: pin.revisionId });
  const c = (pin: typeof a) => [{ path: "wiki/unregistered-c.md", source_refs: [ref(pin)] }];
  assert.doesNotThrow(() => assertNoUnregisteredRetractionDependants([a,b], c(b), new Set([a.path])));
  assert.throws(() => assertNoUnregisteredRetractionDependants([a,b], c(a), new Set([a.path])), /unregistered_dependant/);
  assert.throws(() => assertNoUnregisteredRetractionDependants([a,b], c(b), new Set([a.path,b.path])), /unregistered_dependant/);
  assert.throws(() => assertNoUnregisteredRetractionDependants([a,b], [{path:"wiki/c.md",source_refs:null}], new Set([a.path])), /reference_shape/);
});
