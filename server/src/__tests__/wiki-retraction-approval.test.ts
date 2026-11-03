import { test } from "vitest";
import assert from "node:assert/strict";
import { resolveReviewedWikiRetraction } from "../services/wiki-retraction-approval.js";
import type { PublicationRegistry } from "../services/wiki-publication-readback.js";

function input() {
  const h = "a".repeat(64);
  const registry = { schema: "colo.shared-wiki-publication-readback/v1", companyId: "c", wikiId: "default", spaceSlug: "default", qaAgentId: "qa",
    entries: [{ path: "wiki/p7.md", producerAgentId: "author", wikiSHA256: h }] } as PublicationRegistry;
  const proposal = { schema: "paperclip.wiki-retraction-request/v1", pluginId: "wiki", target: {
    companyId: "c", wikiId: "default", spaceSlug: "default", path: "wiki/p7.md", contentHash: h }, reason: "Correct the assumption" };
  return { companyId: "c", pluginId: "wiki", issueId: "issue", documentKey: "proposal", registry,
    document: { id: "doc", companyId: "c", latestRevisionId: "r2", latestBody: JSON.stringify(proposal),
      createdByAgentId: "author", createdByUserId: null as string | null, updatedByAgentId: "author" },
    review: { id: "review", companyId: "c", issueId: "issue", kind: "request_confirmation", status: "accepted", result: { outcome: "accepted" },
      payload: { target: { type: "issue_document", issueId: "issue", documentId: "doc", key: "proposal", revisionId: "r2" } },
      sourceRunId: "author-run", resolvedByAgentId: "qa", resolvedByRunId: "qa-run" },
    run: { id: "qa-run", companyId: "c", agentId: "qa", status: "succeeded" } };
}
test("server-loaded same-version independent review resolves its original identity", () => {
  const f = input(); const result = resolveReviewedWikiRetraction(f);
  assert.equal(result.reviewerId, "qa"); assert.equal(result.reviewRunId, "qa-run"); assert.equal(result.proposal.target.path, "wiki/p7.md");
  const human = input(); human.document.createdByAgentId = null as unknown as string; human.document.createdByUserId = "owner";
  assert.equal(resolveReviewedWikiRetraction(human).reviewerId, "qa");
});
test("a stale document, author self review, forged resolver, or unresolved run cannot authorize withdrawal", () => {
  const stale = input(); stale.document.latestRevisionId = "r3"; assert.throws(() => resolveReviewedWikiRetraction(stale), /current independently/);
  const self = input(); self.review.resolvedByAgentId = "author"; assert.throws(() => resolveReviewedWikiRetraction(self), /independently/);
  const forged = input(); forged.review.resolvedByAgentId = "other-agent"; assert.throws(() => resolveReviewedWikiRetraction(forged), /Configured independent/);
  const pending = input(); pending.run.status = "running"; assert.throws(() => resolveReviewedWikiRetraction(pending), /Completed independent/);
  const sameRun = input(); sameRun.review.sourceRunId = "qa-run"; assert.throws(() => resolveReviewedWikiRetraction(sameRun), /same-version/);
});
test("company, scope, target hash, rejected verdict and review target mismatches fail closed", () => {
  const variants = [
    (f: ReturnType<typeof input>) => { f.document.companyId = "other"; },
    (f: ReturnType<typeof input>) => { f.review.companyId = "other"; },
    (f: ReturnType<typeof input>) => { f.registry.spaceSlug = "other"; },
    (f: ReturnType<typeof input>) => { f.registry.entries[0]!.wikiSHA256 = "b".repeat(64); },
    (f: ReturnType<typeof input>) => { f.review.result.outcome = "rejected"; },
    (f: ReturnType<typeof input>) => { f.review.payload.target.issueId = "other"; },
    (f: ReturnType<typeof input>) => { f.run.agentId = "other"; },
  ];
  for (const change of variants) { const f = input(); change(f); assert.throws(() => resolveReviewedWikiRetraction(f)); }
  assert.equal(variants.length, 7);
});
