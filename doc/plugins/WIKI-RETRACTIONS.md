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

## Retaining existing unregistered bytes for inspection

An operator may supply `preservePaths` to keep existing unregistered pages
viewable without pretending their arbitrary legacy source metadata is verified.
Their physical paths, byte hashes and complete source-reference hashes are
pinned in `fence.preservedPages`. The preview also enumerates every current
metadata row in `existingPages` with a reference hash and its actual read
control, including unselected legacy pages that will be refused. This full
census uses the same strongest-prior-fence precedence as live reads and is rebuilt at execution. Read control describes withdrawal fences; authorization and current publication proofs are still mandatory; partial or unfamiliar references cannot hide
a known page from the impact proposal. Filesystem-only/unindexed paths remain
explicitly refused by `unindexedPathPolicy`. Each selected page is also a `blocked_by_retraction`
entry with the citation-holds policy; it is never put into `readable`.

The structured reader retains the original body and an explicit unverified-source
warning. Plain/string reading and verified citation reuse remain refused. This
is deliberately not an automatic related/unrelated classifier: unknown reference
formats cannot silently grant verified use. Normalization, independent QA and
any new publication remain separate operations.

Selection receives the same exact-proposal independent QA and human-only
consent. Execution rebuilds every pin, and the common reader rechecks metadata
and bytes. Previously citation-held bytes may be selected again only after their old metadata and byte proofs pass the same live structured-read checks. Earlier strict refusals cannot be revived. Missing metadata, byte
changes and physical aliases are rejected. Unselected/future pages, direct
withdrawals, old strict fences and the ordinary Wiki write hold keep their
existing controls. Existing event records are never rewritten.

## Operator path

All three routes require authenticated board access and company authorization.
No new employee mutation tool or general permission grant is introduced.

1. `POST /api/plugins/:pluginId/wiki-retractions/preview` with `companyId`,
   canonical `wikiId`, `spaceSlug`, `path`, and `reason` returns a JSON proposal.
   Preview has no mutation effect. It resolves the original publication document and requires its stored creator, document ID, revision and body hash to match the target pin. It also checks every registered page's file hash
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

The index original is retained. The log retains its exact original byte prefix and receives the entry-owned append described below. Citation-aware log reading validates that prefix and each recorded append; strict legacy reading remains held. There is no fabricated new index or historical-job rewrite. Old Task outputs and
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

The activity chain records entry-owned events. Full PostgreSQL/HTTP runtime
execution, independent review of the latest increment and production acceptance
remain open; do not call this milestone done.

## Entry-owned maintenance log

New citation-policy withdrawals and republications compute an exact append for
`wiki/log.md` before committing their authoritative DB event. The event seals the
original prefix byte count/hash, append bytes/hash and resulting file hash. The
append contains the event ID/type, withdrawal ID, target/hash, reason, actor,
Run, time, previous event hash and previous log hash. The event ID links to the
resulting hash in the authoritative receipt; the line does not hash itself.

After the event commits, the host reacquires the same company/plugin lock and
performs the append once. It verifies the canonical existing log file and exact
prefix, opens with append/no-follow semantics and fsyncs. A complete identical
append is read back without adding bytes. A partial or foreign suffix is unknown
and refuses any further append. New operations refuse an unfinished previous log.
No old receipt or original page is rewritten, and legacy freeze-policy receipts
are not upgraded. All original prefix checks use UTF-8 bytes, including Japanese.

The DB receipt and withdrawal hold remain authoritative if that derived append
fails. Repeating the completed operation returns its receipt and **does not retry
the append**. The audit returns preserved historical prefixes with current file
hash/size; republication receipt readback separately reports log `appended`,
`pending` or `unknown`. A pending/unknown log is not milestone completion. A later
log-only repair requires receipt investigation, rather than replaying withdrawal
or publication. The local file journey covers original-prefix preservation,
duplicate append readback, a subsequent publication append and partial-write
refusal. Actual DB/HTTP runtime qualification remains unreceived.


Every host byte reader, including UI/discovery readers, now rechecks a new
republication's current stored document, creator/last editor, exact QA record,
completed Run and configured pin before returning bytes. The QA-record hash is
sealed in the publication event. Revoked or changed QA cannot leave the immutable
file looking currently accepted in the UI. These row locks last through the file
read; an already returned historical response cannot be recalled. Unrelated raw
paths do not perform this publication check. A missing last editor is rejected.
New-leaf planning resolves the nearest existing physical ancestor, and checks the
created leaf again before DB publication, so an internal parent symlink cannot
separate the physical file from its receipt.


Current UI checks and republication planning now use the same recursive
publication verifier as tool reads, including actual namespace `source_refs`
and each referenced review's current completed Run. New-publication-specific
creator/last-editor and sealed-review checks remain part of that one reader
graph. A second, partial UI proof is not used. Physical-only page rows retain
host citation holds through the merge, and the browse tree marks those rows
`[引用利用保留]` as well as the detail view. The corresponding DB counterexamples
remain unexecuted locally; the physical merge and actual tree-label function are
exercised with isolated files.

A publication receipt checks its own verified maintenance-log byte range. Later valid appends do not turn an earlier completed append into pending. Partial or foreign suffixes remain unknown and are never automatically retried.


Registered original pages and reviewed new versions use the same current
publication proof during host reads. A matching document revision/body alone
does not suffice: the actual creator and last agent editor must match the pin,
no user editor may replace that author, and the independently resolved QA Run
must still be succeeded in the same company for the named reviewer. Host-owned
review readers supply that Run; it is excluded from the historical review hash
and is never accepted from worker arguments. Current space root-folder ownership
and active status are read under a shared row lock. Unregistered retained files
keep their separate byte/hold contract and receive no registered proof.

## Namespace and completion identity

While a withdrawal exists, every Wiki-root folder operation checks the recorded
space against the current `path_prefix`, `root_folder_key` and active status under
the same lock. Changing a space configuration cannot relocate a withdrawal.
An invalid binding blocks folder operations until the operator restores it; raw
capture continues normally when the binding is valid.

New withdrawal fences record the physical paths that were registered. Deleting a
publication pin cannot downgrade an original page to an unregistered retained
file. A historical fence without that classification fails closed when the
current pin is absent. Original unregistered index/log files retain their own
byte and citation-hold contract.

The republication POST returns the same read-back receipt shape as GET. HTTP 200
requires matching publication bytes and an appended maintenance record. A
committed event with a pending/unknown append returns HTTP 409 with its receipt,
not a claim of operation completion. Repeated POSTs never resume the append;
use GET to inspect the existing operation.


Current-space validation is shared by normal folder access and withdrawal
preview/execute; a second withdrawal cannot permanently mix incompatible roots
or prefixes. Historical audit, completed-operation identity and receipt lookup
retain access to their original records even when current configuration is invalid.

If the first POST's derived append throws after the publication commit, the
runtime marks that specific phase as `wiki_republication_post_commit_unresolved`.
The route reads the committed receipt and returns409 with `completionIssue`, even
if all bytes are visible after an unconfirmed sync. Earlier authorization, intent,
file and SQL errors are not normalized as committed success. No append is retried.


Withdrawal and republication use the same post-commit append and HTTP response
boundary. Withdrawal POST also returns its receipt, with409 on unresolved log
completion. GET `wiki-retractions/operations/:operationId` reads that evidence
without repeating the effect. The successful withdrawal response is now a
receipt envelope with `state`, `event`, `maintenanceLog` and
`automaticRetryAllowed`; callers must read `event` for the historical event.

Wiki-root access and both Board transitions also require an exclusive physical
root for the company. A same or nested root configured for another company is
refused before files are read or written. Uncreated roots claim their prospective physical namespace through the nearest
existing ancestor. Host and Board configuration validate the proposed target
before preparing or saving it; writes also check after preparation. Other ownership lookup errors
fail closed. Instance-administrator edits outside the host remain outside this
boundary.

Root configuration takes an exclusive plugin claim lock. Normal operations share
that lock, in addition to the company operation lock. Both public configuration
writers use the same prospective-root contract; creating a missing parent is not
an escape from ownership checks. Historical receipt/audit reads remain available.


Folder inspection itself can create a write probe. All Wiki inspectors (host
access/configuration, Board list/status/validate/configuration, and withdrawal or
publication setup) therefore pass one guarded inspector. It checks the selected
prospective path under the claim lock before inspection. Refused foreign roots
receive no probe writes. Tests count attempted probe writes, not just final files.


Immutable republication uses the same `extractWikiLinks` function as ordinary
page registration. The function is exported through the SDK package; the server does not import optional-plugin source files. Its `wiki_pages.backlinks` index participates in normal
`wiki_list_backlinks` discovery. This navigation index does not replace the
independent document-version/source-reference publication proof. Only the rendered body is indexed, not the machine lineage header. Recognized Wiki links in that body must have an exact declared dependency pin (an explicit self link is allowed); a withdrawn or held target is refused before publication.


Wiki display and publication now share a Markdown AST walk and target normalizer
from the shared runtime, with compatibility exports through the SDK. The host UI already builds and consumes that shared runtime; it does not acquire a new runtime dependency on prebuilt SDK UI artifacts. The parser uses the same CommonMark/GFM grammar as the renderer.
Wiki shorthand, local Markdown page links and reference-style definitions resolve
to canonical page paths before dependency checks and backlink indexing. The Wiki
renderer uses this same walk when Wiki links are enabled; ordinary non-Wiki routes
and external URLs remain ordinary links. Code examples, HTML and external URL
labels are not reinterpreted as Wiki citations. Existing plain Wiki-path prose
references remain indexed, outside those excluded AST nodes.

This replaces scanning Markdown bytes for link-like substrings. The same actual
React Markdown renderer and publication resolver have paired synthetic cases;
the real PostgreSQL publication fixture includes a shorthand and reference-style
link to one declared source, alongside an external URL, and checks one canonical
backlink through the registered discovery tool.


Reference resolution carries the current logical page path and space. Explicit
relative Markdown paths resolve against that page without escaping the Wiki/raw
namespace. Link destinations use the same space as the page whose evidence was
verified. Absolute application URLs remain application navigation and do not
declare a Wiki source; use canonical Wiki links and declared source pins for that
proof. A local source path that cannot be resolved causes E_INVALID_WIKI_REFERENCE
before publication. The renderer preserves unresolved ordinary Markdown anchors
for author inspection instead of deleting them silently.


All path-bearing relative Markdown links share the Wiki resolver, including
extensionless paths. Schemes, absolute application URLs, and same-page query/hash
navigation are opaque URI classes. There is no extension/prefix allowlist for
relative citations. Navigation indexing remains separate from publication proof:
ordinary source capture retains its existing indexing behavior, while reviewed
immutable publication sets strictInvalidReferences and refuses unresolved source
targets before any file effect. Its withdrawn/dependency checks always apply to
the resolved canonical references, whether an extension was present or not.
