# Conditional board review start

Use normal `PATCH /api/issues/:id` with `boardReviewExpected: {revision, statusVersion}` to start the first review of a completed execution. The caller must be the board, the issue must still be `in_progress`, and its execution policy/state must be unset. Only `status: in_review`, `executionPolicy`, a nonempty `comment`, and optional `commentClientRequestId` accompany this precondition.

The server checks the version and absence of active issue runs before preparing the transition, then again under the issue row lock in the transaction that writes the pending stage. A stale request fails with 409. This path does not stop the old worker or cancel a run. Closed execution workspaces require a separate reopen action. Dispatch and run-bound QA verdicts retain their existing contracts.

`expectedRevision` remains the title/description contract; it does not authorize review transitions. A successful conditional start is not an independent QA result or owner business acceptance.

## Deployment follow-up

The Codex QA installer was observed creating root directories as 0700 under a root umask of 077 despite requesting 0755. The existing dedicated directories were repaired to root-owned 0755 and UID501 traversal and `codex --version` were verified. A future installer change must apply explicit descriptor-based chmod to newly created directories and test creation under umask 077 plus execution by the actual service UID. Do not remove quarantine or relax ownership/write restrictions.
