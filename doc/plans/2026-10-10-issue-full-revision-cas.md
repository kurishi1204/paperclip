# Native issue revision compare and swap — Codex fallback plan v0.4

Date: 2026-10-10. Base: `kurishi1204/paperclip` `master` at
`a9a20fb5c6c080884ced7ee0a4e3b04f9cbf3a6e`. This is a local implementation
plan, amended 2026-10-11 to describe the subsequent native material extension.
Claude planning was unavailable within the current input limit. The candidate is
unadopted. A separate review of its exact code revision and a deployment
decision remain required.

## Purpose and boundary

An issue's `statusVersion` changes for selected status/ownership decisions. It
does not identify every issue-row edit. A GET `ETag` is not a PATCH condition.
Introduce a monotonic issue revision and let a caller condition one
metadata update on the exact revision returned by GET. An old revision must
fail before a comment, run cancellation, wake, or other external effect. Missing
or unobservable revision must fail closed on the conditional path.

The first slice covers every update to the `issues` row, including writes by
existing clients. The subsequent native material slice also advances the same
revision for issue comments, linked current documents, relation edges,
attachments, label memberships, issue-linked document annotations, and issue
thread interactions, including human answers. A transaction-scoped capture
returns a digest of those rows. Neither the revision nor digest is a complete
company request or business acceptance version.

## Implementation sequence

1. Add `issues.revision bigint not null default 0` and a database trigger that
   increments it for every issue-row UPDATE. Expose `revision` on GET and list
   models. Keep `statusVersion` unchanged for its existing semantics. Generate
   and inspect the migration and schema snapshot.
2. Add an optional `expectedRevision` to the PATCH validator, client type, UI
   API, and CLI. Its value must be an exact safe nonnegative integer. The
   conditional path supports only board title/description fields. Bypass the
   generic execution-policy transition for this path: even an unrelated text
   edit could otherwise clear an existing `executionState`. Reject comment,
   run-control, review verdict, assignment, and other combinations before any
   effect occurs.
3. In the issue service, compare `expectedRevision` to the row obtained under
   `FOR UPDATE` in the same transaction as the update. On mismatch, return a
   typed HTTP 409 and write neither the issue row nor related state. Make
   authorization and transition decisions use the locked row on this path.
4. Extend the issue-row serialization point to the listed native child rows
   with database triggers. Capture the issue and child rows while holding the
   issue lock, then compare revision and digest in the same transaction as a
   durable outbox write. The companion plan in
   `2026-10-11-issue-requirement-children-cas.md` defines the covered rows and
   exclusions. A PATCH that adds a comment reads the committed issue row again
   before returning its full response, so its revision can be used by the next
   conditional edit.
5. Test the old revision after a title/description edit, concurrent
   conditional writers, wrong company, malformed values, and a stale request
   that also asks to cancel/comment. Cover the execution-state reset fault.
   Prove fault tests fail on the baseline for the intended reason, then make
   them pass. Test child mutations and response revision against real
   PostgreSQL. Run targeted tests and type checks.

## Explicit limits and next integration

Existing unconditioned PATCH clients remain supported; their writes still
advance the revision and invalidate old conditional clients. The conditional
path is **not** a general replacement for Paperclip's ordinary task mutation
flow. GET still assembles projections in separate queries and cannot serve as
an atomic freeze. The internal capture is not yet a live API or execution
broker. Parent/child task graph, watchdog instructions, referenced project and
goal content, external file bytes, execution results, QA, and business
acceptance require separate version binding or an explicit hold. A task that
depends on the child graph or watchdog configuration must be held in an initial
company run until those bindings exist. Local tests are not deployed-runtime
acceptance. No production issue, run, credential, or deployment is changed by
this plan.
