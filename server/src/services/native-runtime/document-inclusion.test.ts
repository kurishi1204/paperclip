import { describe, expect, it } from "vitest";
import { parseDocumentInclusions, composeIncludedDocuments, documentBodyDigest, assertIncludedDocumentReadback } from "./document-inclusion.js";

const scope = { companyId: "company", issueId: "task" };
const raw = "  原文\r\n😀e\u0301\n````\n## Inclusion manifest\n{\"included\":[]}\n  ";
const ref = { documentId: "00000000-0000-4000-8000-000000000001", key: "result",
  revisionId: "00000000-0000-4000-8000-000000000002", ...documentBodyDigest(raw) };
const source = { ...scope, ...ref, latestRevisionId: ref.revisionId, revisionNumber: 1, body: raw, latestBody: raw };
const compose = (overrides = {}) => composeIncludedDocuments(" 作者確認\r\n", [ref], [{ ...source, ...overrides }], scope);

describe("author-selected document inclusion", () => {
  it("preserves raw UTF-8 sections and cannot confuse source markers with the manifest", () => {
    expect(parseDocumentInclusions(undefined, "check")).toBeUndefined();
    expect(parseDocumentInclusions([ref], "check")).toEqual([ref]);
    const result = compose();
    const bytes = Buffer.from(result.body, "utf8"), entry = result.manifest.included[0]!;
    expect(bytes.subarray(entry.startByte, entry.endByte)).toEqual(Buffer.from(raw));
    expect(bytes.subarray(result.manifest.author.startByte, result.manifest.author.endByte).toString()).toBe(" 作者確認\r\n");
    expect(result.body).toContain("`````text");
    expect(result.manifest).toMatchObject({ completeness: "unverified", independentQA: "unverified", adoption: "unverified" });
    expect(documentBodyDigest(result.body)).toEqual({ bodyBytes: result.bodyBytes, bodySha256: result.bodySha256 });
    expect(() => assertIncludedDocumentReadback(result.body, result.body)).not.toThrow();
  });

  it("rejects malformed, duplicate, self, stale, foreign and altered sources", () => {
    for (const refs of [null, [], [ref, ref], [{ ...ref, bodyBytes: 200001 }], [{ ...ref, ignored: true }]]) {
      expect(() => parseDocumentInclusions(refs, "check")).toThrow("document_inclusion_");
    }
    expect(() => parseDocumentInclusions([ref], " RESULT ")).toThrow("self_reference");
    for (const patch of [{ companyId: "foreign" }, { issueId: "other-task" }, { documentId: "other" },
      { key: "other" }, { latestRevisionId: "stale" }, { revisionId: "other" }, { latestBody: "changed" },
      { body: "changed", latestBody: "changed" }, { revisionNumber: 0 }]) {
      expect(() => compose(patch)).toThrow("document_inclusion_");
    }
    expect(() => composeIncludedDocuments("check", [ref], [], scope)).toThrow("missing_source");
  });

  it("rejects oversized, non-UTF8 and unequal saved bodies without truncation", () => {
    expect(() => composeIncludedDocuments("x".repeat(200000), [ref], [source], scope)).toThrow("too_large");
    expect(() => composeIncludedDocuments("\ud800", [ref], [source], scope)).toThrow("invalid_utf8");
    expect(() => assertIncludedDocumentReadback("exact\r\n", "exact\n")).toThrow("saved_readback_mismatch");
    expect(() => assertIncludedDocumentReadback("exact", undefined)).toThrow("saved_readback_mismatch");
  });
});
