# Wiki withdrawal

Status: connected local implementation; not deployed or accepted for production.
The event contract is `server/src/services/wiki-retraction-ledger.ts`.
The board operation is `wiki-retraction-runtime.ts`; the common file boundary
is in `plugin-host-services.ts`. Publication receipts remain separate.

A withdrawal retains original bytes. It stops use of the target and marks dependent citations
for review while keeping downstream bodies readable through the structured
reader; their other claims are not declared false. This first
version deliberately pauses **writes in the affected Wiki tree**, including new
pages, for ordinary plugin mutations. The separate Board publication transition below can add a reviewed immutable version. Immutable
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

The local preview/execute route now emits `citation-holds`; execute requires
the server-resolved same-version human decision and separate independent QA.
This code is not deployed. A reviewed immutable republication entry is connected locally; its real PostgreSQL/HTTP acceptance and production acceptance remain incomplete. Existing `freeze-wiki` ledger events are unchanged and remain
strict; never activate the policy by rewriting an event or configuration.

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


## Reviewed immutable republication

The responsible author saves a **new issue document** containing the revised
Markdown. Its first bytes are this hidden metadata comment; independent QA reviews
the entire document, including the target and dependency hashes:

```markdown
<!-- paperclip.wiki-republication/v1
{"companyId":"company UUID","wikiId":"default","spaceSlug":"default","retractionId":"recorded withdrawal UUID","previousPath":"wiki/synthesis/held.md","path":"wiki/synthesis/revalidated.md","reason":"What was rechecked","dependencies":[{"path":"wiki/sources/current.md","wikiSHA256":"current 64-character SHA-256"}]}
-->

# Revised conclusion

Explain the responsible author's revalidation and the remaining usable claims.
```

The new document must be created and maintained by the original registered
author. The host checks the original document's stored creator as well as the
publication pin. QA must be the configured reviewer, distinct from the author and
executor, with an accepted interaction bound to this exact document revision and
a completed successful QA Run. Every declared dependency must pass current
publication verification without citation holds. Semantic completeness of the
dependency list is part of that human/employee review, not a Markdown parser claim.

An authenticated Board caller posts `companyId`, `issueId`, `documentKey`,
`reviewId`, and a fresh UUID `operationId` to
`POST /api/plugins/:pluginId/wiki-retractions/republications`. The runtime reloads
and locks the records, commits a durable intent, then revalidates under the same
company/plugin lock. It creates the new file without overwriting any existing
leaf, records page/revision metadata, appends a publication pin while preserving
all old pins, and commits a `republished` event in the existing hash chain. The
whole reviewed Markdown is copied exactly, retaining the normal publication proof.

The withdrawal's human decision ID in the new event is **withdrawal lineage**,
not consent to the revised body. New publication authority comes from the
authenticated Board operation and its separately resolved exact-version QA.
The original withdrawal, original file, downstream citation holds and other
ordinary write restrictions remain unchanged. Only the newly committed path is
readable as a new verified version. A direct withdrawn source cannot use this entry.
The new version can itself be withdrawn by a later normal withdrawal.

`GET /api/plugins/:pluginId/wiki-retractions/republications/:operationId?companyId=...`
returns the durable intent/receipt and observed file hash without returning the
body. A completed identical POST reads its receipt. A prepared/unknown operation
is never automatically repeated. If a DB failure follows file creation, the intent
remains, metadata/pins/event roll back, and the unregistered file stays blocked.
There is no automatic deletion, retry or rollback of file effects.

The activity chain records entry-owned events. Appending the separate Wiki
maintenance log, full PostgreSQL/HTTP execution, independent review of this
increment and production acceptance remain open; do not call this milestone done.
