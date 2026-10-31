import { test } from "vitest";
import assert from "node:assert/strict";
import { applyWikiPublicationReadback, verifyWikiPublication, publicationCanonical, publicationHash, type JsonObject, type PublicationRegistry } from "../services/wiki-publication-readback.js";

function fixture() {
  const documents: Record<string, JsonObject> = {}; const reviews: Record<string, JsonObject> = {}; const pages: Record<string, JsonObject> = {};
  const registry: PublicationRegistry = { schema: "colo.shared-wiki-publication-readback/v1", companyId: "company", wikiId: "default", spaceSlug: "default", qaAgentId: "qa", entries: [] };
  for (const name of ["source", "synthesis"]) {
    const body = `審査された本文 ${name}`; const contents = `収録メモ\n${body}`;
    const ref = { kind: "document", issueId: name, documentId: `doc-${name}`, documentKey: name, revisionId: `rev-${name}` };
    documents[name] = { id: ref.documentId, companyId: "company", issueId: name, latestRevisionId: ref.revisionId, body };
    const review: JsonObject = { id: `qa-${name}`, companyId: "company", issueId: name, status: "accepted", sourceRunId: "producer-run", resolvedByAgentId: "qa", resolvedByRunId: "qa-run", resolvedAt: "2026-10-30T14:00:23.540Z", payload: { target: { key: "native_completion_review" } }, result: { outcome: "accepted" } };
    reviews[name] = review; pages[name] = { path: name, wikiId: "default", spaceSlug: "default", contents, hash: publicationHash(contents), sourceRefs: [ref] };
    registry.entries.push({ path: name, issueId: name, documentId: ref.documentId, documentKey: name, revisionId: ref.revisionId, producerAgentId: "producer", reviewId: review.id as string, wikiSHA256: publicationHash(contents), documentBodySHA256: publicationHash(body), reviewRecordSHA256: publicationHash(publicationCanonical(review)), sourceRefsSHA256: "" });
  }
  (pages.synthesis!.sourceRefs as unknown[]).push(structuredClone((pages.source!.sourceRefs as unknown[])[0]));
  for (const pin of registry.entries) pin.sourceRefsSHA256 = publicationHash(publicationCanonical(pages[pin.path]!.sourceRefs));
  let reads = 0;
  const readers = { page: async (path: string) => { reads++; return pages[path]!; }, document: async (id: string) => documents[id]!, review: async (id: string) => reviews[id]! };
  const result = { content: pages.synthesis!.contents as string, data: { companyId: "company", wikiId: "default", spaceSlug: "default", path: "synthesis", hash: pages.synthesis!.hash } };
  const run = (args: unknown = { companyId: "company", path: "synthesis" }, configuration: unknown = registry) => applyWikiPublicationReadback(configuration, "company", args, result, readers);
  return { registry, documents, reviews, pages, result, run, reads: () => reads };
}

test("employee tool receives the same body and a current parent citation", async () => {
  const f = fixture(); const out = await f.run(); const proof = (out.data as JsonObject).publicationReadback as JsonObject;
  assert.equal(out.content, f.result.content); assert.equal(proof.state, "verified"); assert.equal((proof.dependencies as JsonObject[])[0]!.documentId, "doc-source");
  const citation = proof.citation as JsonObject; assert.equal(citation.bodyByteStart, Buffer.byteLength("収録メモ\n")); assert.equal(f.reads(), 2);
});
test("parent revision change rejects before returning the synthesis body", async () => { const f = fixture(); f.documents.source!.latestRevisionId = "new"; await assert.rejects(f.run(), /document_changed/); });
test("parent QA revocation rejects the dependent tool result", async () => { const f = fixture(); f.reviews.source!.status = "rejected"; await assert.rejects(f.run(), /review_not_accepted/); });
test("accepted review payload cannot be changed under an old receipt", async () => { const f = fixture(); f.reviews.source!.payload = { target: "other" }; await assert.rejects(f.run(), /review_changed/); });
test("deleted dependency metadata cannot hide a parent", async () => { const f = fixture(); (f.pages.synthesis!.sourceRefs as unknown[]).pop(); await assert.rejects(f.run(), /references_changed/); });
test("Wiki body tampering is rejected", async () => { const f = fixture(); f.pages.synthesis!.contents += " changed"; await assert.rejects(f.run(), /page_changed/); });
test("mismatched worker tool body is rejected after the records pass", async () => { const f = fixture(); f.result.content = "wrong tool response"; await assert.rejects(f.run(), /tool_body_changed/); });
test("another company cannot use the configured publication registry", async () => { const f = fixture(); f.registry.companyId = "other"; await assert.rejects(f.run(), /registry_scope/); assert.equal(f.reads(), 0); });
test("source document company mismatch is rejected", async () => { const f = fixture(); f.documents.source!.companyId = "other"; await assert.rejects(f.run(), /document_changed/); });
test("caller parameters cannot change company", async () => { const f = fixture(); await assert.rejects(f.run({ companyId: "other", path: "synthesis" }), /request_scope/); assert.equal(f.reads(), 0); });
test("unregistered pages explicitly retain unverified status", async () => { const f = fixture(); f.result.data.path = "not-registered"; const out = await f.run({ companyId: "company", path: "not-registered" }); assert.match(out.content, /unverified source material/); assert.equal(((out.data as JsonObject).publicationReadback as JsonObject).state, "unregistered"); assert.equal(f.reads(), 0); });
test("malformed configured registry is not silently disabled", async () => { const f = fixture(); f.registry.entries[0]!.wikiSHA256 = "invalid"; await assert.rejects(f.run(), /registry_hash/); });
test("self-reviewed publication cannot pass", async () => { const f = fixture(); f.registry.entries[0]!.producerAgentId = "qa"; await assert.rejects(f.run(), /review_not_independent/); });
test("database Date receipts hash like their API JSON representation", async () => { const f = fixture(); f.reviews.source!.resolvedAt = new Date(f.reviews.source!.resolvedAt as string); await f.run(); });

test("tool metadata cannot point at another page under a verified body", async () => { const f = fixture(); f.result.data.path = "other"; await assert.rejects(f.run(), /tool_metadata_changed/); });


test("canonical receipt JSON sorts integer-like keys lexically", () => {
  assert.equal(publicationCanonical({ "2": "two", "10": "ten" }), '{\n  "10": "ten",\n  "2": "two"\n}\n');
});

test("canonical receipt JSON orders full Unicode code points", () => {
  assert.equal(publicationCanonical({ "😀": "astral", "\uE000": "bmp" }), '{\n  "\uE000": "bmp",\n  "😀": "astral"\n}\n');
});

test("a shared ancestor is checked once in a single dependency read", async () => {
  const pages: Record<string, JsonObject> = {};
  const documents: Record<string, JsonObject> = {};
  const reviews: Record<string, JsonObject> = {};
  const registry: PublicationRegistry = { schema: "colo.shared-wiki-publication-readback/v1", companyId: "company", wikiId: "default", spaceSlug: "default", qaAgentId: "qa", entries: [] };
  const add = (name: string, parents: string[]) => {
    const ref = { kind: "document", issueId: name, documentId: "doc-" + name, documentKey: name, revisionId: "rev-" + name };
    const body = "Body for " + name;
    const review: JsonObject = { id: "qa-" + name, companyId: "company", issueId: name, status: "accepted", sourceRunId: "writer-run", resolvedByAgentId: "qa", resolvedByRunId: "qa-run", resolvedAt: null, payload: {}, result: { outcome: "accepted" } };
    documents[name] = { id: ref.documentId, companyId: "company", issueId: name, latestRevisionId: ref.revisionId, body };
    reviews[review.id as string] = review;
    pages[name] = { path: name, wikiId: "default", spaceSlug: "default", contents: body, hash: publicationHash(body), sourceRefs: [ref, ...parents.map(p => (pages[p]!.sourceRefs as unknown[])[0])] };
    registry.entries.push({ path: name, ...ref, producerAgentId: "writer", reviewId: review.id as string, wikiSHA256: pages[name]!.hash as string, documentBodySHA256: publicationHash(body), reviewRecordSHA256: publicationHash(publicationCanonical(review)), sourceRefsSHA256: publicationHash(publicationCanonical(pages[name]!.sourceRefs)) });
  };
  let previous: string[] = [];
  for (let level = 0; level < 7; level++) {
    const names = [`level-${level}-a`, `level-${level}-b`];
    for (const name of names) add(name, previous);
    previous = names;
  }
  add("root", previous);
  const pageReads: string[] = [], documentReads: string[] = [], reviewReads: string[] = [];
  const readers = {
    page: async (path: string) => { pageReads.push(path); return pages[path]!; },
    document: async (id: string) => { documentReads.push(id); return documents[id]!; },
    review: async (_id: string, id: string) => { reviewReads.push(id); return reviews[id]!; },
  };
  await verifyWikiPublication(registry, "root", readers);
  for (const reads of [pageReads, documentReads, reviewReads]) {
    assert.equal(new Set(reads).size, registry.entries.length);
    assert.equal(reads.length, registry.entries.length);
  }
  // A later tool call must check current records again, not reuse a global cache.
  documents["level-0-a"]!.latestRevisionId = "changed";
  await assert.rejects(verifyWikiPublication(registry, "root", readers), /document_changed/);
});

test("dependency cycles are still rejected with per-read caching", async () => {
  const f = fixture();
  (f.pages.source!.sourceRefs as unknown[]).push((f.pages.synthesis!.sourceRefs as unknown[])[0]);
  f.registry.entries[0]!.sourceRefsSHA256 = publicationHash(publicationCanonical(f.pages.source!.sourceRefs));
  await assert.rejects(f.run(), /dependency_cycle/);
});


test("duplicate document publication bindings are refused before record reads", async () => {
  const f = fixture();
  f.registry.entries.push({ ...f.registry.entries[0]!, path: "alternate-source-path" });
  await assert.rejects(f.run(), /registry_document_ambiguous/);
  assert.equal(f.reads(), 0);
});


for (const [label, args] of [
  ["leading slash", { companyId: "company", path: "/synthesis" }],
  ["Wiki whitespace", { companyId: "company", path: "synthesis", wikiId: " default " }],
  ["space case", { companyId: "company", path: "synthesis", spaceSlug: "DEFAULT" }],
] as const) {
  test(`resolved alias ${label} receives the registered proof`, async () => {
    const f = fixture(); const result = await f.run(args);
    assert.equal(((result.data as JsonObject).publicationReadback as JsonObject).state, "verified");
    assert.equal(result.content, f.result.content); assert.equal(f.reads(), 2);
  });
  test(`resolved alias ${label} cannot skip a changed source`, async () => {
    const f = fixture(); f.documents.source!.latestRevisionId = "changed";
    await assert.rejects(f.run(args), /document_changed/);
  });
  test(`resolved alias ${label} cannot skip revoked QA`, async () => {
    const f = fixture(); f.reviews.source!.status = "rejected";
    await assert.rejects(f.run(args), /review_not_accepted/);
  });
}

test("a resolved page in another Wiki remains unregistered", async () => {
  const f = fixture(); f.result.data.wikiId = "another-wiki";
  const result = await f.run({ companyId: "company", path: "synthesis", wikiId: "another-wiki" });
  assert.equal(((result.data as JsonObject).publicationReadback as JsonObject).state, "unregistered");
  assert.equal(f.reads(), 0);
});

test("an unregistered read cannot return another company's metadata", async () => {
  const f = fixture(); f.result.data.companyId = "other"; f.result.data.path = "not-registered";
  await assert.rejects(f.run({ companyId: "company", path: "not-registered" }), /tool_metadata_changed/);
  assert.equal(f.reads(), 0);
});

test("missing resolved metadata cannot silently opt out of verification", async () => {
  const f = fixture(); delete (f.result as { data?: unknown }).data;
  await assert.rejects(f.run({ companyId: "company", path: "/synthesis" }), /tool_metadata_changed/);
  assert.equal(f.reads(), 0);
});
