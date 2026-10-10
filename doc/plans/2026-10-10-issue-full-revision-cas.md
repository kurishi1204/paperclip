# Issue row revision compare and swap — Codex fallback plan v0.2

Date: 2026-10-10. Base: `kurishi1204/paperclip` `master` at
`a9a20fb5c6c080884ced7ee0a4e3b04f9cbf3a6e`. This is a local implementation
plan. Claude planning was unavailable within the current input limit. A separate
review of the exact code revision and a deployment decision remain required.

## Purpose and boundary

An issue's `statusVersion` changes for selected status/ownership decisions. It
does not identify every issue-row edit. A GET `ETag` is not a PATCH condition.
Introduce a monotonic full issue-row revision and let a caller condition one
metadata update on the exact revision returned by GET. An old revision must
fail before a comment, run cancellation, wake, or other external effect. Missing
or unobservable revision must fail closed on the conditional path.

The revision covers **every update to the `issues` row**, including writes by
existing clients. Comments, document revisions, work products, and relations
are separate rows and do not become part of this revision without an explicit
follow-up contract. Do not describe this row revision as a complete company
request or business acceptance version.

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
4. Test the old revision after a title/description edit, concurrent
   conditional writers, wrong company, malformed values, and a stale request
   that also asks to cancel/comment. Cover the execution-state reset fault.
   First prove the new fault tests fail on the baseline for the intended
   reason, then make them pass. Run targeted tests, typecheck, and build if
   dependency installation succeeds.

## Explicit limits and next integration

Existing unconditioned PATCH clients remain supported; their writes still
advance the revision and invalidate old conditional clients. The conditional
path is **not** a general replacement for Paperclip's ordinary task mutation
flow. A broker must separately freeze all company requirement material, bind
the issue revision plus any document/comment revisions, and use a reviewed
atomic effect path before it can send a result or QA verdict. The current
Paperclip deployment is a different commit, so local tests are not Mini
acceptance. No production issue, run, credential, or deployment is changed by
this plan.
