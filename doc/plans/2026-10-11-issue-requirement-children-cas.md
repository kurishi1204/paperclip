# Native issue material CAS — Codex fallback plan v0.4

Date: 2026-10-11. Base: local fork commit `f0dfe013c68fba8fdb767ec55340353bbe433e9f`.
This is an unadopted local candidate. It does not deploy Paperclip, send a
company request, or mark a business task accepted. Independent review of the
exact final head remains required.

## Observed gap

The first change serializes updates to the `issues` row. Issue material also
lives in child rows. A new comment, changed plan document, document annotation,
or human answer previously left `issues.revision` unchanged in real PostgreSQL
red tests. A caller could therefore condition a title edit on an old revision
while request material had changed. A PATCH that added a comment also returned
the issue row from before the comment trigger, causing a false conflict on the
next conditional edit. `GET /issues/:id` loads projections in separate queries,
so its single response is not an atomic freeze. Tests use local synthetic data.

## Scope and sequence

1. Migration 0313 adds `BEFORE` row triggers to native comments, issue document
   links, linked document updates, relation edges, attachment links/asset
   metadata, label memberships, issue-linked document annotation threads and
   comments, and issue thread interactions. Each trigger acquires the related
   issue row lock before changing child material and increments
   `issues.revision` in its own transaction. Relation edges increment both
   endpoints; moving a child link increments its old and new issue. Pure lazy
   comment attribution backfills are excluded from semantic changes.
2. An internal capture routine holds `issues FOR UPDATE`, reads all listed
   native material in a stable order, and returns only a schema version,
   revision, SHA-256 digest, and table counts. Bodies are hashed in memory and
   never logged or returned by this routine. A companion check rereads under
   the same lock and returns 409 on a changed revision or digest. A caller must
   do this check inside the transaction that stages its durable outbox effect;
   calling it before a network send alone has a race.
3. The full PATCH response rereads the committed issue after inserting a
   comment; otherwise the returned revision predates the comment trigger.
4. Real PostgreSQL tests cover the previously red comment/document,
   annotation, human-answer, and PATCH-response paths; document updates,
   relation endpoints and deletion, label/attachment changes, stable
   snapshots, wrong-company read, stale comparison, and a concurrent child
   insert blocked by the frozen issue row. Migration checks and targeted type
   checks gate this local candidate.

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
- The snapshot includes issue-linked document annotation threads, their
  comments, and all `issue_thread_interactions`, including human question
  results. They may be execution evidence rather than owner instructions; the
  conservative token invalidates a freeze when they change. A future semantic
  contract can separate those roles, but must preserve explicit answer binding.
- The parent/child issue graph is execution decomposition and is outside this
  single-issue snapshot. A new child does not advance its parent's revision.
  Watchdog instructions are separate execution control. An initial company
  request that depends on either must be held until separately version-bound.
  This is not a whole-company requirement freeze.
- `issue_work_products`, independent QA verdicts, and business acceptance are
  downstream results and require their own evidence and version checks.
  Project and goal contents referenced by an issue likewise require separate
  version binding.
- The existing `GET /issues/:id` is unchanged and remains a non-atomic
  projection. A live API route or broker integration for this internal receipt
  is a later step and must be reviewed before external use.
