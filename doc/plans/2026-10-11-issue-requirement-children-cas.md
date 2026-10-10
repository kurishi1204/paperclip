# Native issue material CAS — Codex fallback plan v0.3

Date: 2026-10-11. Base: local fork commit `f0dfe013c68fba8fdb767ec55340353bbe433e9f`.
This is a second, unadopted change. It does not deploy Paperclip, send a
company request, or mark a business task accepted. Independent review of the
exact final head remains required.

## Observed gap

The first change serializes updates to the `issues` row. Actual issue material
also lives in `issue_comments`, `issue_documents` plus `documents`, and
`issue_relations`. A new comment or changed plan document left `issues.revision`
unchanged in a real PostgreSQL red test. A caller could therefore condition a
title edit on an old revision while the request text had changed. `GET /issues/:id`
loads the issue and document/relation projections in separate queries, so its
single response is not an atomic freeze. The example uses only local test data;
production request content is outside this plan.

## Scope and sequence

1. Migration 0313 adds `BEFORE` row triggers to native comments, issue document
   links, linked document updates, relation edges, attachment links/asset
   metadata, and label memberships. Each trigger acquires the related issue row
   lock before changing child material and increments `issues.revision` in its
   own transaction. Relation edges increment both endpoints. Pure lazy comment
   attribution backfills are excluded from semantic changes.
2. An internal capture routine holds `issues FOR UPDATE`, reads all listed
   native material in a stable order, and returns only a schema version,
   revision, SHA-256 digest, and table counts. Bodies are hashed in memory and
   never logged or returned by this routine. A companion check rereads under
   the same lock and returns 409 on a changed revision or digest. A caller must
   do this check inside the transaction that stages its durable outbox effect;
   calling it before a network send alone has a race.
3. Real PostgreSQL tests cover the previously red comment/document paths,
   document updates, both relation endpoints and deletion, label/attachment
   changes, stable snapshots, wrong-company read, stale comparison, and a
   concurrent child insert blocked by the frozen parent row. Migration checks
   and targeted type checks gate this local candidate.

## Boundaries for the company run

- This receipt is an internal version token, not a grant to execute. The
  commander still needs owner scope, budget, selected task/agent, and a
  separate durable outbox before external execution.
- The digest includes all native comments, including agent results. That can
  invalidate a prior freeze during a running task. The first company run should
  freeze immediately before staging each effect, and the later product contract
  should distinguish owner requirement comments from execution transcript.
- Current linked document content and metadata are included. Historical
  non-current `document_revisions` are not current request content. File bytes
  remain in external asset storage; this receipt covers asset metadata and its
  recorded SHA-256, not independent retrieval of the bytes.
- An edge's presence is included for both related issues. The linked issue's
  later status or body change does not advance its neighbor's revision;
  dependency readiness must be checked separately at dispatch. Label IDs are
  covered, while a rename of the shared label record is not.
- `issue_work_products`, `issue_thread_interactions`, independent QA verdicts,
  and business acceptance are downstream results and require their own
  evidence and version checks. Project and goal contents referenced by an
  issue likewise require separate version binding.
- The existing `GET /issues/:id` is unchanged and remains a non-atomic
  projection. A live API route or broker integration for this internal receipt
  is a later step and must be reviewed before external use.
