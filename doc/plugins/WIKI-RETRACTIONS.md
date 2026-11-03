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

## Citation-aware read work in progress

The experimental `citation-holds` fence policy preserves pinned downstream
bytes and marks invalid citations separately. `localFolders.readTextWithStatus`
is a capability-gated host method; the string reader still refuses held pages.
The Wiki read tool and page UI retain the body with explicit citation warnings.
The publication verifier independently reconstructs invalid reference metadata;
it never upgrades the whole page to an unconditional proof. Legacy fences stay
strict and cannot be weakened by the new reader. Indexed discovery retains downstream rows with machine-readable citation holds and text warnings; direct withdrawals remain hidden. Writes remain frozen.

The current execute/preview route still emits only `freeze-wiki`. Owner-consent
resolution, new-publication release and production
acceptance of the citation policy are not complete. Do not activate it by
rewriting a ledger event or configuration.

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
3. Obtain a separate `human_only` confirmation addressed to the owner for the
   exact proposal document/revision. The accepted interaction must be resolved
   by that human user, with no agent/run attribution. QA remains a separate
   completed independent review. The executor must be the consenting owner;
   a random operation UUID is never an owner decision.
4. `POST .../execute` with `companyId`, `issueId`, `documentKey`, `reviewId`, `ownerDecisionId`, and
   a fixed UUID `operationId` supplies retry identity only. Actor identity,
   approval, and model-independent run identity are read from authenticated/server
   records. Agent arguments cannot supply them. The current proposal is compared
   with a fresh snapshot under the execution lock.
5. `GET .../audit?companyId=...` is board-only and returns the receipt plus original
   files from the recorded root, with byte-hash preservation checks. These are
   historical audit bytes, not current citable Wiki content.

The execution receipt stores the owner decision interaction ID, operation ID and actor, exact proposal
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

## Root identity during an active withdrawal

A persisted fence is relative to its recorded physical root. Host folder operations
reject a different current root with `runtime_root_changed`. Changing configuration
does not rebase or retire the withdrawal. Restore the matching root or implement a
separately reviewed transition. No original bytes are deleted by this rejection.

New file leaves resolve their nearest existing parent before the write-hold check.
An existing raw-directory alias into the Wiki tree cannot create a new Wiki page.
Raw capture under the unchanged root remains available. While a withdrawal is
active, raw writes do not run folder preparation that could recreate held metadata.

## Discovery result windows

Search, page/backlink/source tools and UI page/source lists share one visible-row
collector. A held row does not consume the caller's result limit. The collector
continues through stable ordered SQL windows until it fills the visible window
or reaches the end. The hidden count describes scanned windows, not a global total.
If the existing local-browse scan budget is exhausted with more candidates left,
the operation fails with `E_WIKI_RETRACTION_SCAN_INCOMPLETE` and observed counts;
it does not report a false empty complete result. Raw-source ordering includes a
path tie-breaker. This does not claim a transactional snapshot across concurrent
metadata changes or define the still-unaccepted in-flight response contract.

The worker's ordinary `sources` data handler uses the same withdrawal visibility
rule even when it does not request `onlyReadable`. Inactive ordinary metadata
listing remains separate from a full readable-file inventory. A physical local
walk's `truncated` bit is preserved through the host; the UI consumer reports
`E_WIKI_LOCAL_SCAN_INCOMPLETE` rather than presenting a partial or empty list as
complete. SQL collection uses batches even when the caller requests one result;
the caller's visible count and the existing scan bound are still respected.

All indexed discovery consumers, including the UI's readable-page and
readable-source variants, now share one visibility/error policy. During an
active withdrawal only an explicit withdrawal tombstone removes a row; other
boundary errors fail the request. Inactive ordinary metadata may still precede
a materialized raw file, and inactive readable-only lists still omit unreadable
files. The active root-change failure is exercised through the actual gate and
UI consumers, with a fixed SDK status fixture; it is not an authenticated HTTP
acceptance claim.

The common collector checks the host boundary before loading SQL candidates,
including a no-match query. An empty result cannot report an unchecked moved
root as healthy or an active withdrawal as inactive.

An active hold does not make every raw metadata row require materialized bytes.
The common host read helper performs root, lexical and canonical-path checks
first. Only a final ENOENT with the same existing physical root is normalized to
`E_WIKI_SOURCE_NOT_MATERIALIZED`. Default metadata lists may retain that row;
readable-only lists omit it. All other boundary errors fail the request. An
alias in another space that points to a held Wiki file is rejected before this
absence outcome, so space names cannot bypass the file fence. Other plugins and
inactive Wiki reads retain their previous errors. The actual host helper, file
paths, aliases and both metadata/readable consumers are exercised together;
space resolution and SQL selection remain fixtures in the local journey.
