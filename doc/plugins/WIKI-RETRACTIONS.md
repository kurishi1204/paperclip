# Wiki withdrawal

Status: connected local implementation; not deployed or accepted for production.
The event contract is `server/src/services/wiki-retraction-ledger.ts`.
The board operation is `wiki-retraction-runtime.ts`; the common file boundary
is in `plugin-host-services.ts`. Publication receipts remain separate.

A withdrawal retains original bytes. It stops use of the target and holds entire
dependent pages for review; their other claims are not declared false. This first
version deliberately pauses **writes in the affected Wiki tree**, including new
pages, until a separately reviewed publication transition is available. Immutable
raw capture and raw reading continue. Other companies and other Wiki spaces are
outside that path fence.

## Operator path

All three routes require authenticated board access and company authorization.
No new employee mutation tool or general permission grant is introduced.

1. `POST /api/plugins/:pluginId/wiki-retractions/preview` with `companyId`,
   canonical `wikiId`, `spaceSlug`, `path`, and `reason` returns a JSON proposal.
   Preview has no mutation effect. It checks every registered page's file hash
   and source-reference hash, computes direct/indirect dependencies, and refuses
   an indexed unregistered document-dependent page rather than silently omitting it.
2. Save that exact JSON as an issue document and obtain a normal independent
   `request_confirmation` review of its current document revision. The resolver
   must be the configured Wiki QA agent, distinct from the author/publisher, with
   a completed successful run. A review of a different document/version/company
   cannot authorize withdrawal.
3. `POST .../execute` with `companyId`, `issueId`, `documentKey`, `reviewId`, and
   a fixed UUID `operationId` is the explicit owner decision. Actor identity,
   approval, and model-independent run identity are read from authenticated/server
   records. Agent arguments cannot supply them. The current proposal is compared
   with a fresh snapshot under the execution lock.
4. `GET .../audit?companyId=...` is board-only and returns the receipt plus original
   files from the recorded root, with byte-hash preservation checks. These are
   historical audit bytes, not current citable Wiki content.

The execution receipt stores the owner operation ID and actor, exact proposal
revision/body hash, review/run identity, registry hash, affected physical paths,
and the still-readable registered-page hashes. Repeating an already recorded
operation reads its original receipt without another append, even if the proposal
or publication configuration subsequently changes.

## Enforcement

The existing activity log is authoritative. A company/plugin PostgreSQL advisory
lock covers both the real local-folder effect and the withdrawal audit commit.
There is no independent mutable status that can commit before the audit.

Ordinary tool and UI reads pass the same host file boundary. Withdrawn pages,
dependants, index/log files, and unregistered new Wiki paths return a hold instead
of their bodies. Unaffected registered pages remain readable only while their
hashes match the recorded snapshot. Physical aliases are resolved before access.
Discovery tools rebuild both their data and display text and report hidden entries.
Removing publication pins cannot remove a persisted withdrawal.

Index/log originals are retained, not overwritten. Their normal display is held;
there is no fabricated new index or historical-job rewrite. Old Task outputs and
model contexts are historical material, not automatically repaired citations.

## Verification and activation limits

The focused suite exercises real synthetic files, actual registered Wiki tools,
UI page reads, search/list/backlink snippets, approval/version/company mismatch,
hash corruption, concurrent receipts, and write holds while raw capture continues.
Its local Vitest result is recorded outside source; it is not production acceptance.

`wiki-retraction-database.test.ts` requires real PostgreSQL in CI and fails CI if
the engine cannot start. It checks duplicate receipt serialization, actual INSERT
rollback, and a queued real-file write across the commit barrier. These new SQL
assertions have not run locally: the host's native engine reports exhausted shared
memory IDs. No production database was used as a test substitute.

Normal installation remains blocked by a pre-existing manifest/lockfile mismatch;
the lockfile was not rewritten. Targeted checking uses existing pinned tools.
Full workspace typecheck/build, authenticated HTTP acceptance, independent code
review, deployment, the concrete owner-authorized withdrawal, independent after
observation, old Task/skill citation invalidation, model evidence, and a safe
publication/version transition remain unaccepted. The temporary Wiki write hold
must be an explicit rollout decision, not an unnoticed operational regression.

An administrator able to rewrite the underlying DB or Wiki root is outside this
ledger's trust boundary. Do not delete a receipt or overwrite a page to restore it.
