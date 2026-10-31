# Current publication evidence for employee Wiki reads

The host can optionally verify published Wiki copies when employees call
`paperclipai.plugin-llm-wiki:wiki_read_page`. Both the native tool gateway and
`/api/plugins/tools/execute` use the same dispatcher. Existing authentication,
company boundaries, and tool authorization still run before this readback.

## Operator configuration

Store a `publicationReadback` object in the existing company-scoped plugin
configuration. Preserve the other configuration keys. This is operator data;
callers cannot supply or replace it through tool arguments. No database
migration, plugin capability, or employee permission change is required.

```json
{
  "publicationReadback": {
    "schema": "colo.shared-wiki-publication-readback/v1",
    "companyId": "company-id",
    "wikiId": "default",
    "spaceSlug": "default",
    "qaAgentId": "independent-reviewer-id",
    "entries": [{
      "path": "wiki/sources/example.md",
      "issueId": "issue-id",
      "documentId": "document-id",
      "documentKey": "example",
      "revisionId": "published-revision-id",
      "producerAgentId": "producer-id",
      "reviewId": "accepted-interaction-id",
      "wikiSHA256": "<sha256 of complete UTF-8 Wiki contents>",
      "documentBodySHA256": "<sha256 of complete UTF-8 document body>",
      "reviewRecordSHA256": "<sha256 of canonical review basis>",
      "sourceRefsSHA256": "<sha256 of canonical complete sourceRefs array>"
    }]
  }
}
```

Build the registry from existing publication and accepted independent QA
receipts. Registering a receipt does not approve new content. Canonical JSON
uses recursively sorted object keys, two-space indentation, unescaped Unicode,
and a trailing newline. The review basis contains `id`, `companyId`, `issueId`,
`status`, `sourceRunId`, `resolvedByAgentId`, `resolvedByRunId`, `resolvedAt`,
`payload`, and `result`; missing values are null and dates use API ISO strings.

## Read behavior

For a registered page, the host checks the complete Wiki body and references,
the current document revision and body, the exact accepted QA interaction and
its distinct reviewer/run, and every referenced registered parent recursively.
The document body must occur exactly once in the Wiki copy. The worker tool
body must equal the verified page body. A mismatch fails the tool call before
the body is returned. Errors have the `wiki_publication_` prefix.

A matching result keeps the original body and adds `data.publicationReadback`
with `state: "verified"`, document and QA identifiers, byte offsets, hashes,
and direct parent citations. This proves receipt/version continuity at read
time; it does not revalidate external facts or claim every Wiki page is reviewed.

Other pages remain readable with a visible unverified-source notice and
`state: "unregistered"`. Companies without this setting retain existing behavior.
A malformed configured registry is an error, not an automatic opt-out.

This feature does not publish documents, create Tasks/Runs, call a model, or
modify original documents or QA interactions. Enabling it in a running service
requires deploying the host change and adding the operator configuration.
