# Completion reviews after a saved writer continuation

A writer can receive another ordinary comment while its completion review is
queued. If that continuation finishes first, its saved result needs a review
of its own. Keeping the old card as a governance gate advances the issue's
status decision but invalidates the queued review assignment. Neither result
then has an executable review path.

The native finalization reconciler retires that obsolete request only when the
latest applied decision is a pending interaction gate, the same writer has
successfully committed a later result under the current completion contract,
and that result explicitly requests the same independent agent reviewer.
The old card must be a system-created native completion review, bound through
its original status-decision effect. No issue execution may be active. Any
attempt to execute the old review must have been cancelled before dispatch
with `issue_assignee_changed`; an attempt that began execution prevents this
automatic handoff.

A persisted requested or effective restriction prevents automatic retirement, even if company policy later becomes less restrictive.

Retirement records a withdrawal, never an approval. The activity record links
the old request, current status decision, and saved replacement result. The
old results, decisions and cancelled run stay unchanged. A durable retirement
marker lets the usual reconciler reassess the current saved result after a
restart and create one new, version-bound review request. It does not rerun
the writer or replay provider/tool calls. Repeated reconciliation does not
create additional cards or wakes.

Human approvals, execution-stage gates, answered reviews, a changed assignee
or contract, failed workspace finalization, and reviews that have begun work
remain governed by their existing rules. Review assignment still requires
the issue's current status decision and projected status version to match;
the handoff does not relax that authority check or the independent-review
policy. Replacement commit rechecks current writer ownership, execution inactivity
and the latest contract while retaining the issue/coordinator locks. Changed
work-product evidence alone cannot complete an issue with pending governance
or an explicit attention request.

The real-PostgreSQL cases in `native-status-arbiter-corpus.test.ts` exercise a
writer result, its ordinary continuation, the obsolete queued review, normal
reconciliation, restart after retirement, and preservation of the remaining
authorities. Product acceptance additionally requires observing the named
reviewer resolve the current saved document in the running service.

This change does not modify the adopted human-verdict service. Its historical
human actor path does not share the agent assignment currency check; hardening
that separate path remains a known baseline limitation. This operational
milestone uses only the named independent agent's version-bound verdict. It
neither substitutes a human verdict nor claims general human-verdict hardening.

The saved-result authority guard decorates the existing committer's transaction
factory; it does not add an outer transaction or change the committer's normal
post-commit publication boundary. Earlier coordinator phases and terminal runs
whose status has not been projected resume through the normal finalizer. New
evidence uses full finalizer arbitration, including durable dependencies, with
a second dependency/readiness check under the commit authority locks.

Workspace recovery uses its existing ownership and failure policy before evidence
reassessment. A handoff lookup, candidate transaction or retirement publication
failure is logged and isolated so unrelated normal recovery continues; a committed
withdrawal remains durable even if its live publication fails.

An authoritative later issue status change retains precedence over new evidence.
Saved-result final arbitration does not replace a detected later authoritative
status change. The selected arbitration path also selects its matching commit guard.

A named handoff consumes its durable marker only when the saved result can
materialize the requested named review. An intervening confirmation or
unread child that prevents replacement keeps that marker pending. Governance and child delivery are
rechecked inside the commit, so clearing another wait can resume the same saved
result without a replacement writer run.

Saved-result recovery isolates each coordinator after the adopted pending-effect
integrity checks, including replacement creation and post-commit publication. An unavailable named reviewer leaves the original
coordinator and withdrawal marker recoverable; the failure is logged with the
run and issue, never reported as completion. Other coordinators continue.

An ordinary followup can advance the completion contract before its writer
continuation finishes. The old review may belong to an earlier contract only
when it is in the latest contract's explicit `supersedesContractId` ancestry,
with each link owned by this company/issue and strictly decreasing revision.
The new saved result must still belong to the latest current contract. No old
result, assessment or contract is rewritten, and an unrelated revision is held.

## Saved document revisions and authors

When a completion review card is created, `bind_reviewer` records every issue
document's `documentId`, `key`, `revisionId` and `revisionNumber` in
`payload.target.boundDocuments`, in the same transaction as the card. A task
without documents records an empty list.

Only the server's continuation summary is bookkeeping rather than submitted
work, and only while its current revision has the internal writer's reserved
activity-log record for the exact company, issue, document, revision and run.
Textual change summaries are not authority. A `continuation-summary` revision
without that server record (including a legacy or imported marker) is bound like
any document, so the next system refresh makes the review stale instead of the
content passing unreviewed. The pipeline case body (`pipeline-case-body`) is
authored case content linked into the conversation issue and is always bound.

The system issue document keys are reserved at the shared document service.
Ordinary saves, restores and removals of `continuation-summary` or
`pipeline-case-body` (issue document routes, runner tools, plugins) return 422
`issue_document_key_reserved`. The continuation summary writer passes an
internal option naming its key as a separate argument, never from a request
body. The pipeline links its case body directly, and the commander result
writer refuses a reserved key.

Acceptance, through the HTTP route, the reviewer's `resolve_review` tool or a
system actor, re-reads the issue documents while holding the issue row
`FOR UPDATE`, then applies these checks in order:

- A linked, non-system document without a current revision makes the saved set
  unverifiable: 409 `native_completion_review_documents_inconsistent`. It is
  never treated as absent.
- A native completion review is genuine only when the status committer
  materialized it: a system-created card with a `bind_reviewer` status-decision
  effect pointing at it for the decision named in `target.revisionId`. A card
  that only carries the target key returns 409
  `native_completion_review_provenance_missing`, with or without documents.
- A genuine card saved before this binding existed carries no document set:
  409 `native_completion_review_documents_unbound` once the issue has
  documents. A task without documents still completes normally.
- Each document appears once in the binding and the binding equals the whole
  current set (same ids, keys and revisions). A repeated entry, a later
  revision, an added document or a removed document returns 409
  `native_completion_review_documents_stale`.

The card is server-owned. The ordinary interaction create entry rejects the
`native_completion_review` target key with 422
`native_completion_review_reserved`, and a client-supplied `boundDocuments` on
any custom target with 422 `native_completion_review_binding_server_owned`.
Only the status committer's system identity creates the card and records the
binding, and an idempotent replay reuses the recorded value. Tests that do not
drive the real finalizer create cards through
`server/src/__tests__/helpers/native-completion-review-fixture.ts`, which
writes the same decision chain and effect the committer does. The binding has no count cap, because issue
documents have none: every submitted document is recorded.

The issue row is the only lock used. The `paperclip_bump_issue_revision_from_child`
triggers (migration 0313) lock the issue `FOR UPDATE` before every
`issue_documents` insert, update or delete and every update of a linked
`documents` row, whichever service, route or import performs it. A writer
therefore waits for an approval that holds the issue, and an approval waits for
a writer that already reached the trigger and then sees its committed change.
The reader does not lock document rows: a writer holds its document row before
its trigger waits for the issue, so a document share lock would deadlock (40P01).

An approving agent must not have written any revision up to a bound revision,
whether the revision records it in the agent column or only through its creating
run. That case returns 403 `native_completion_review_author_excluded`. Author
exclusion applies to an agent's independent content QA only. A human resolver
keeps the existing addressee and `human_only` audience rules and may decide on
documents they wrote; the version binding still applies. System actors keep
their existing rules.

Rejection stays available in each of these cases, so the reviewer can send stale
work back and the worker can resubmit the current revisions. The rule adds no
database column, migration, resolver policy or reviewer tool. `human_only` cards
remain human-only.

The "native completion review document binding" cases in
`paperclip-control-plane-port.test.ts` drive the native finalizer and the real
HTTP create/accept/reject and document routes against PostgreSQL. They cover
multiple documents, a revision saved after submission, both agent-authorship
forms, a `human_only` owner deciding on their own revision (including after a
later revision), a task without documents, an unbound card, a linked document
without a current revision, a client-supplied duplicate binding, a repeated
entry in a server-owned binding, 501 documents, both orders of a concurrent
document write and approval, the reserved system document keys at the ordinary
document route, a bound pipeline case body, a continuation summary that is not a
system refresh (including an exact forged text marker), the reserved activity API action, and a native card without status-decision provenance.

The reserved keys are `SYSTEM_ISSUE_DOCUMENT_KEYS` in
`packages/shared/src/constants.ts` (`continuation-summary`,
`pipeline-case-body`, checked by `isSystemIssueDocumentKey`).

## Server provenance of continuation summaries

A textual change summary and run ID are not provenance: an earlier ordinary writer could copy them. The internal summary refresh records its exact document/revision/run tuple in the existing activity log in the same transaction as the revision write. The ordinary activity create service rejects this reserved action for every caller. Only that recorded tuple exempts a summary revision from submitted work. Legacy/imported revisions without that record stay bound, including ones with forged text markers; they may require one normal resubmission after the first genuine server refresh. No legacy record is backfilled or silently trusted. Pipeline case bodies remain bound.
