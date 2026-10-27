# LLM Wiki

Local-file LLM Wiki plugin for source ingestion, wiki browsing, query, lint, and maintenance workflows.

## Scope

This package is the standalone home for LLM Wiki behavior. Wiki-specific routes,
UI, prompts, tools, local-folder templates, migrations, fixtures, and tests live
here rather than in Paperclip core.

The alpha surface includes:

- manifest-declared Wiki page, sidebar entry, and settings page
- trusted local folder declaration for `raw/`, `wiki/`, `AGENTS.md`, `IDEA.md`, `wiki/index.md`, and `wiki/log.md`
- plugin database namespace migration for wiki instances, sources, pages, operations, query sessions, and resource bindings
- managed `Wiki Maintainer` agent, managed `LLM Wiki` project, and paused managed routines for wiki update processing, lint, and index refresh
- plugin-operation issue creation using `surfaceVisibility: "plugin_operation"`
- local source capture into `raw/` with metadata rows in the plugin DB namespace
- opt-in company-scoped Paperclip event ingestion controls for issues, comments, and documents; event ingestion is disabled by default and routes captured raw provenance into the default space only
- manual Paperclip project/root issue distillation and bounded backfill actions with explicit work items, operation issues, source caps, and estimated cost recording
- Paperclip-derived distillation (cursor windows, manual `distill-now`, backfill) always writes into the default wiki space in Phase 1; non-default spaces remain on manual / raw-file ingest until per-space Paperclip ingestion profiles ship
- Paperclip-derived distillation maintains `wiki/projects/<slug>/standup.md` as the executive current-state view for each represented project, alongside durable `wiki/projects/<slug>/index.md` knowledge pages
- wiki page writes with plugin path validation, atomic local-folder writes, metadata/revision rows, backlink extraction, and optional stale-hash protection
- wiki tools for search/read/write/propose patch/source/log/index/backlinks workflows

## Phase 5 Security Gate

### Opt-in owner comment raw capture (local implementation slice)

The `ownerCommentRawCapture` company plugin config is off by default. Version 1
requires `enabled: true`, a shared active `spaceSlug` with an enabled comments
profile containing only `root_issues` scopes, one `ownerUserId`, an explicit
list of at most 25 exact `issueIds`, `allowCompanyReaders: true`, a bounded
`maxBodyBytes`, and an `internal` classification decision by the same user with
an ISO decision time and reference. The event must be attributed to that user,
have no agent/run markers, and identify exactly one unchanged comment. This
does not prove that the user typed the comment in the UI. The administrator's
classification input declares an owner decision; it is not authenticated
evidence of the owner's consent. Configured issue UUIDs and incoming company,
issue, and comment UUIDs are normalized to lowercase, as are reader lookup
UUIDs; duplicate configured issue IDs after normalization are rejected. User
identities remain opaque, case-sensitive strings. Only exact issue IDs are
in scope. Events attributed to other users or agents are skipped; an
owner-attributed event with contradictory agent/run markers is held.

Accepted bytes are the complete comment body. A separate
`paperclip_owner_raw_captures` row claims its version; the file lives under
`.paperclip/owner-comment-raw/<space UUID>/<comment UUID>/<body SHA-256>.txt`
within the space prefix. This path is outside ordinary `raw/` and `wiki/`
readers and writers. A create-only local-folder operation prevents this plugin
from overwriting an existing leaf; the receipt is `verified` only after file,
comment, row, and final file readback. The `owner-comment-raw-source` data
handler rechecks current policy and comment version before returning bytes.
This is a raw receipt, not a normalized source or a published wiki page.
The receipt fingerprint binds the owner, space, internal classification label,
and company-reader permission. Its claim metadata keeps the original consent
decision, issue list, and byte cap. Adding another issue to the current opt-in
does not invalidate the earlier receipt; removing the captured issue or
changing the owner denies current reads.

The plugin table row is the receipt authority. Its `pending` state has no
successful capture meaning; the currently unused `hold` enum does not itself
authorize reads. Separate company-scoped plugin state records the latest
attempt health (`pending`, `hold`, or `verified`) and is updated after successful
final readback. Comment attempt health uses a per-comment key; an invalid
enabled configuration uses one company-scoped `config` key. Out-of-scope
comments create no raw attempt health. A health write failure returns a fixed
error and is logged without file path or body. A `verified` row is still insufficient for reading
when the current comment is edited, deleted, or newly attributed to a run, or
when the saved file no longer matches its exact bytes and hash.

The Paperclip plugin event bus is in-process and has no durable redelivery.
An event lost before delivery or a `pending` receipt with no later event has
no automatic recovery in this slice. Database and filesystem writes are not
one transaction; unknown I/O outcome remains pending or held and must never
be reported as captured. Local tests do not establish a production receipt,
UI origin, retention/deletion behavior, business QA, or permission to send
these bytes to a model. Existing cursor dedup is independent of this raw
receipt. Do not enable on a real company until those missing gates are
separately accepted.

The required enabled comments ingestion profile also admits the same scope to
the existing cursor and distillation pipeline. Before any real opt-in, keep
related routines paused and prohibit manual distill and backfill until their
model-send boundary is separately accepted. The quarantine is a logical
plugin-tool boundary, not a filesystem sandbox: an agent with direct wiki-root
filesystem access can still reach the file. The starter `gitignore.template`
does not exclude `.paperclip/`; verify the actual root's ignore/retention and
agent filesystem reachability before use. Shared-space reader authorization
is not a filesystem access restriction. The board data handler is available to
company-access viewers and does not enforce issue-level ACLs. The secret
detector may reject harmless text that resembles a token. Create-only writes
rely on filesystem hard-link support; a filesystem without it cannot complete
this receipt. The added SDK local-folder method is required by the host/plugin
interface and must be versioned with external implementations. Company/space
row deletion cascades in the plugin database, but orphaned raw files and
retention/deletion are not implemented in this slice.

Paperclip-derived text ingestion stays limited to issue titles/descriptions, issue comments, and issue documents.

- Issue attachments/assets are **metadata-only** in Phase 5.
- Issue work products are **metadata-only** in Phase 5.
- The wiki must not fetch `/api/assets/:id/content`, dereference work-product `url` fields, or store those capability-bearing links in source bundles/snapshots.

The accepted policy lives in [doc/plans/2026-05-06-llm-wiki-paperclip-asset-security-gate.md](../../../doc/plans/2026-05-06-llm-wiki-paperclip-asset-security-gate.md).

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

From the Paperclip repo root:

```bash
pnpm --filter @paperclipai/plugin-llm-wiki typecheck
pnpm --filter @paperclipai/plugin-llm-wiki test
pnpm --filter @paperclipai/plugin-llm-wiki build
```

## Alpha Verification

Run these commands from the Paperclip repo root before handing off alpha plugin
changes:

```bash
pnpm --filter @paperclipai/plugin-llm-wiki typecheck
pnpm --filter @paperclipai/plugin-llm-wiki test
pnpm --filter @paperclipai/plugin-llm-wiki build
```

The focused Vitest suite covers:

- standalone package boundaries and package-local harness dependencies
- required local folder bootstrap writes
- raw source capture plus ingest metadata persistence
- hidden plugin-operation issue creation for ingest/query/file-as-page workflows
- disabled and enabled Paperclip event ingestion paths
- managed routine declarations, manual distill/backfill work items, source cap handling, and backfill project/date scoping
- atomic page writes, metadata/revision rows, backlinks, and stale-hash refusal
- query session creation, run-id recording, stream event forwarding, and completion updates
- filing a streamed query answer back into the wiki through a hidden operation

Remaining alpha gaps:

- Browser screenshot capture is maintained separately under `tests/screenshots`;
  generated `screenshots/` outputs are local artifacts and are ignored by git.
- Host-level plugin install and live agent invocation still need Paperclip
  server/runtime smoke coverage when preparing a release candidate.



## Install Into Paperclip

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/Users/dotta/paperclip/.paperclip/worktrees/PAP-3179-design-a-llm-wiki-plugin/packages/plugins/plugin-llm-wiki","isLocalPath":true}'
```

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.

After changing manifest-loaded assets such as skills, agent instructions, or
templates, recompile the local plugin before re-enabling it:

```bash
pnpm --filter @paperclipai/plugin-llm-wiki build
```

The package-local `dist/` directory is ignored by git, but local Paperclip
installs load the compiled `dist/manifest.js` and `dist/worker.js` files at
runtime. If activation failed before the rebuild, re-enable the plugin or
restart the Paperclip dev server so the host imports the fresh bundle.

## Local File Layout

```text
<configured-wiki-root>/
  AGENTS.md
  IDEA.md
  .gitignore
  raw/
    .gitkeep
  wiki/
    index.md
    log.md
    sources/
      .gitkeep
    projects/
      .gitkeep
      <project-slug>/
        index.md
        standup.md
        decisions.md
        history.md
    entities/
      .gitkeep
    concepts/
      .gitkeep
    synthesis/
      .gitkeep
```

Use the settings page or `bootstrap-root` action to configure the folder and
write the starter files. The plugin uses Paperclip's local folder API for path
containment, symlink checks, read/write validation, and atomic writes.

Bootstrap preserves existing files rather than overwriting operator edits. The
default first-install skeleton is copied from the vanilla LLM Wiki layout, with
`CLAUDE.md` renamed to `AGENTS.md` and Paperclip project overviews, standups,
decisions, and history kept together under `wiki/projects/<slug>/`.

## Managed Agent Instructions

Plugin-managed agent instruction bundles live under:

```text
agents/<agent-key>/AGENTS.md
```

For this plugin the Wiki Maintainer source bundle is `agents/wiki-maintainer/AGENTS.md`.
Any additional files in that folder are installed as sibling instruction files
for the managed agent. The settings health check reports drift from these
defaults, and resetting the managed agent asks for confirmation before replacing
customized instructions.
