# Contributing Guide

Thanks for wanting to contribute!

We really appreciate both small fixes and thoughtful larger changes.

## Before You Start: Search First

Before you start work, **search GitHub** for existing PRs and issues that touch the same area:

- Look for **duplicate or in-flight PRs**. If something close already exists, prefer helping that PR over the line (see [Helping Other Contributors](#helping-other-contributors)) instead of opening a parallel one.
- Look for **related open issues**. Link them in your PR body.
- If an older PR is effectively dead (stale, unmaintained, would be painful to rebase/merge), a fresh PR is fine — just call out the prior PR in your description so the reviewer has context.

Duplicate PRs create extra work for reviewers and make merging harder. A 60-second search saves hours later.

Affirm that you did this search by checking the dedup-search box in the PR template (`I have searched GitHub for duplicate or related PRs and linked them above`). Commitperclip checks for this checkbox on non-trivial PRs.

## Two Paths to Get Your Pull Request Accepted

### Path 1: Small, Focused Changes (Fastest way to get merged)

- Pick **one** clear thing to fix/improve
- Touch the **smallest possible number of files**
- Make sure the change is very targeted and easy to review
- All tests pass and CI is green
- Satisfy the [target repository review gate](#review-gate-kurishi1204paperclip) at the current head
- Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md)

These almost always get merged quickly when they're clean.

### Path 2: Bigger or Impactful Changes

- **First** talk about it in Discord → #dev channel  
  → Describe what you're trying to solve  
  → Share rough ideas / approach
- Once there's rough agreement, build it
- In your PR include:
  - Clear description of what & why
  - Proof it works (manual testing notes)
  - All tests passing and CI green
  - Satisfy the [target repository review gate](#review-gate-kurishi1204paperclip) at the current head
  - [PR template](.github/PULL_REQUEST_TEMPLATE.md) fully filled out

PRs that follow this path are **much** more likely to be accepted, even when they're large.

## PR Requirements (all PRs)

### Use the PR Template

Every pull request **must** follow the PR template at [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). If you create a PR via the GitHub API or other tooling that bypasses the template, copy its contents into your PR description manually. The template includes required sections: Thinking Path, What Changed, Verification, Risks, Model Used, and a Checklist.

### Link Issues or Describe Them In-PR

We do not gate PRs on a pre-existing issue. Two acceptable paths:

1. **Issue exists** — search the [Issues database](https://github.com/paperclipai/paperclip/issues) for anything this PR addresses and tag each one with `Fixes: #123` / `Closes #123` / `Refs #123` so GitHub auto-links them. If there are **duplicate or closely related issues**, link all of them, not just the one you picked. If there are **related PRs** (prior attempts, dependent work, follow-ups, abandoned predecessors), link those too.
2. **No issue exists** — describe the problem directly in your PR body, following one of our [issue templates](.github/ISSUE_TEMPLATE/) so a reviewer has the same fields they'd get from a filed issue:
   - **Bug fix:** what happened, expected behavior, steps to reproduce, Paperclip version/commit, deployment mode. See [`bug_report.yml`](.github/ISSUE_TEMPLATE/bug_report.yml).
   - **Feature:** problem/motivation, proposed solution, alternatives considered, roadmap alignment. See [`feature_request.yml`](.github/ISSUE_TEMPLATE/feature_request.yml).
   - **New adapter:** agent or provider, why it's useful, how it's invoked. See [`adapter_request.yml`](.github/ISSUE_TEMPLATE/adapter_request.yml).

Either way, a reviewer should be able to understand the underlying issue without leaving the PR. Commitperclip may check that one of these two paths is satisfied. Only link **public** GitHub issues — see [No Internal Issue References](#no-internal-issue-references) for what to leave out.

### No Internal Issue References

Many contributors run their own Paperclip instance to manage their work. Issue ids and links from *your* instance are private — reviewers and other contributors cannot open them, so they show up as clutter or broken links.

In your PR title, description, commits, and comments, **only reference public GitHub issues and PRs** — `#123`, `Fixes #123` / `Closes #123` / `Refs #123`, or full `https://github.com/paperclipai/paperclip/...` URLs.

Do **not** include references to internal/instance-local Paperclip work, such as:

- Internal ticket ids like `PAPA-123`, `PAP-224`, or any `{PREFIX}-{NUMBER}` identifier that isn't a public GitHub issue number.
- Instance UI links such as `/PAP/issues/...`, `/PAP/agents/...`, `agent://...`, or document deep links.
- `localhost`, private IP, or tailnet URLs pointing at your own instance.

If an internal issue captured useful context, restate that context in plain English in the PR body instead of linking to it.

### Branch Naming

Tooling (including Paperclip) often names a working branch after an internal issue and task — e.g. `PAPA-42-why-did-this-break`. That name leaks instance-local context, isn't meaningful to reviewers, and ends up as the public branch on your PR.

Before you push, **rename the branch to something descriptive of the change itself**, not of your instance:

- Use short, kebab-case names scoped to the change, optionally with a conventional prefix: `docs/no-internal-issue-references`, `fix/sandbox-secret-resolution`, `feat/adapter-retry-backoff`.
- Do **not** include internal Paperclip ticket ids (`PAPA-123`, `PAP-224`), instance task slugs, or other instance-derived details in the branch name.

To rename and push under the new name:

```bash
git branch -m <descriptive-name>
git push -u origin <descriptive-name>
# If your tooling already pushed the old branch, delete it from origin:
git push origin --delete <old-name>
```

### Model Used (Required)

Every PR must include a **Model Used** section specifying which AI model produced or assisted with the change. Include the provider, exact model ID/version, context window size, and any relevant capability details (e.g., reasoning mode, tool use). If no AI was used, write "None — human-authored". This applies to all contributors — human and AI alike.

### Tests Must Pass

All tests must pass before a PR can be merged. Run them locally first and verify CI is green after pushing.

### Telemetry Changes

This repo has three separate data paths: Telemetry, Observability, and the run log. See rule 7 in `AGENTS.md` for the full definitions and the review level each path needs.

If your change adds, removes, or modifies emitted telemetry events, update the [Telemetry Data Contract](packages/shared/src/telemetry/README.md) in the same PR. Keep clients emitting raw dimension values and avoid documenting or relying on private delivery details. If your change adds, removes, or modifies an OpenTelemetry span or span attribute, keep the change inside the closed span-attribute allowlist in `packages/adapter-utils/src/acpx-engine/startup-timing.ts`. If your change adds or modifies a run-log event, update `doc/run-log-events.md` in the same PR.

### Paperclip Gates Must Pass

All Paperclip CI gates (lint, typecheck, tests, build, and any other required checks) must be satisfied before a PR can be merged. Don't ask for a merge while gates are red — fix them first.

### Review Gate (kurishi1204/paperclip)

For pull requests targeting **kurishi1204/paperclip**, adoption requires all of the following at the exact current head:

- CI and repository-required status checks have actually completed successfully. Missing, pending, failing, skipped or neutral checks are not successful execution evidence.
- An independent, fresh-session Claude Opus 5.5 review reports actual model `claude-opus-5-5`, known successful native/provider completion and one exact final `判定: GO` line. Bind the full launched input, full before/after changed sources and relevant dependencies, head/tree, executor, session and actual result bytes. Configured model names and PR-body claims are insufficient.
- Every received review source has a current disposition: resolved, rejected with concrete evidence, or explicitly not a finding. Include inline threads, reviews, edited general summaries, check outputs, every check annotation and the independent report. Record the source version/body hash, reason and supporting evidence. Classification correctness remains the operator's responsibility; a complete table alone does not prove a fix.
- All existing required approvals, CODEOWNERS decisions, conversation requirements, branch protections and security checks remain satisfied. Maintainers retain the adoption decision. A model GO or a readiness report does not merge or deploy code.

[Greptile](https://greptile.com) is additional review evidence in this fork. Report its actual status, findings and score when received. Unavailable, pending or quota-limited is not 5/5, approval, or a code-quality result. Address actual findings regardless of vendor. Do not run a paid review loop merely to obtain a score. A Greptile check explicitly required by repository protection remains required; this policy does not change settings or bypass it. Other target repositories follow their own contribution rules.

Use the fork path in `.agents/skills/pr-gardening/scripts/check-readiness.mjs` from trusted adopted code. It reads GitHub checks, protections, source and review comments. It supports only an **operator-admitted CLI journal**; missing or unsupported evidence is unreceived/invalid, never a fallback success. It does not require a Paperclip company Task/Run or launch a model. The candidate reader cannot certify its own initial installation. Maintainers must decide that first policy adoption from separately trusted operator execution, independent review and normal CI evidence; a candidate readiness verdict is not that decision.

The operator must be able to read the applicable branch rules and protection. For a protected base, GitHub requires **Administration repository permissions (read)** for a fine-grained token on [Get branch protection](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection). Confirm that prerequisite for the actual operator. An unreadable protection response remains unknown; do not remove protection or substitute model approval.

The trusted operator configures a private `--trusted-review-root` outside PR checkouts and pins `registry.json` with `--trusted-review-registry-sha256`. Do not derive either value from the PR. A `--review-evidence` pointer has no authority; its inline `approved`, model and verdict claims are ignored. Registry schema `paperclip.operator-review-registry/v1` admits one `trusted-cli-journal/v1` entry per repository/PR/head and an actual executor. Each entry binds `key`, `purpose: independent_implementation_review`, a required non-empty `implementationSessionID` from the actual implementation execution, `sourceInputSHA256`, `cliInvocationPath`, `cliSHA256` and artifact paths/hashes for `start`, `claim`, `process`, `terminal`, `raw`, `report`, `system`, `material`, `launcher` and the actual `cli` snapshot. These artifacts must remain within the private admitted root. The reader joins the actual START/CLAIM/PROCESS/native terminal record, raw first-party provider response, actual model/session, input bytes, admitted launcher/CLI hashes and exact final report. The v1/v2 kinds support only the admitted one-shot high-effort, tools-disabled CLI argument shape; different or resumed launch shapes remain invalid. The reader requires the operator-bound implementation session ID and checks that it differs from the actual launched review session ID, comparing case-insensitively; absent or invalid IDs remain `implementation_session_unreceived`, and reuse remains `review_not_independent`. The trusted operator must verify the implementation ID against its real execution record before admitting it. The reader does not independently authenticate that implementation record or prove independence from different strings alone. A derived `RESULT.json` success flag alone cannot pass.

An explicit lossless source uses registry entry kind `trusted-cli-journal/v2` with `sourceSchema: paperclip.fork-review-source/v2`. The existing v1 kind remains valid with no `sourceSchema` field. Unknown or mixed kind/schema pairs and multiple source blocks are invalid. V2 carries whole after source and a canonical exact reverse diff; the trusted reader reconstructs full before source, verifies both Git blob hashes and the logical v1 source hash, then applies the same journal, CI, findings and protection gates. `sourceInputSHA256` continues to bind the reconstructed canonical v1 object. The private report identifies the representation. V2 proves byte reconstruction and delivery through the admitted journal, not context fit or semantic understanding. A candidate introducing v2 cannot use it for its own first adoption.

A separate candidate kind, `trusted-cli-read-journal/v1` with `sourceSchema: paperclip.fork-review-read-corpus/v1`, checks one operator-pinned, read-only CLI stream. It uses the same complete logical source: whole after files, canonical reverse diffs for changed before files, removed before files, and every selected dependency become individual read-only corpus files.
Physical corpus names are content-bound `assets/<digest>.txt`; repository paths and roles stay in the pinned manifest, so a changed `AGENTS.md`, `CLAUDE.md` or tool configuration file is never placed under its instruction filename.
The pinned manifest is rebuilt from GitHub; every file must be returned in successful `Read` tool results in the same fresh session, with exact line coverage and bytes. `Glob` and `Grep` are discovery only.
The operator provides pinned `manifest`, `corpusPre`, `corpusPost`, `attempts` and `stream` artifacts in addition to the shared launcher, CLI, start, claim, process, terminal, system, material and report artifacts.
Each Read packet is the newly emitted directory containing `manifest.json` and its sibling `corpus/`; the selected manifest artifact identifies that packet, so one private registry root can hold distinct packets for separate PRs.
The corpus is private and outside the checkout; symlinks, writable files, unsupported encoding, missing reads, ambiguous stream events, compaction, retries after an unknown attempt, and non-GO verdicts fail closed.
Its pinned launch settings disable auto-memory and hooks, use managed-only AGENTS plugin instructions, and exclude CLAUDE files and rules at the corpus and ancestor paths.
The operator must separately verify its actual CLI/environment and managed settings; these recorded fields do not prove that all hidden context was absent.
The recorded model/provider and tool results are operator-admitted evidence, not provider authentication or proof of semantic understanding or context fit.
This candidate kind cannot certify its own initial installation; use the adopted inline review gate, normal CI and maintainer decision before any operator admission or deployment.

The Read kind renders each reverse diff as deterministic multiline JSON with short before-text segments. It reconstructs the same canonical v2 reverse diff and complete logical before bytes. The existing CLI can prepare its private corpus with `check-readiness.mjs --emit-review-input <PR> --repo kurishi1204/paperclip --source-schema read --review-dependencies <comma-separated relevant paths> --output <absolute-new-directory> --check-only`; omit `--check-only` to write the manifest, material, pre-inventory and hashed read-only assets from that same generator. An unsupported physical display-line profile fails before writing. The same check-only and written material recommend bounded `Read` offset/limit ranges from numbered display bytes and name the absolute corpus root. The generator keeps the final empty LF line with the preceding range because an isolated EOF-empty `Read` was not measured. The 16 KiB target matches one observed CLI run; it is not a delivery guarantee for future versions or every context. This profile does not prove the actual CLI can deliver every long line. The measured Claude Code 2.1.306 init reports three builtin plugins and four builtin agents; the Read decoder requires that exact set plus empty MCP servers, skills, slash commands and additional directories. Builtin declarations do not mean a subagent was spawned or prove all hidden context is absent. The operator still pins the emitted files, executes one separately authorized review, records the post-inventory and stream, and applies the normal admission gate.

For an existing PR, emit the complete source block before review with `--emit-review-input <PR> --repo kurishi1204/paperclip --review-dependencies <comma-separated relevant paths> --output <outside-checkout-file>`. Include that block byte-for-byte once in the launched material. Review input binds the repository, head/tree and complete source bytes; it need not have a PR number at review time. This command requires an existing PR; it is not a local-tree emitter. For a pre-PR source review, a trusted operator must prepare the same complete source contract from pinned Git blobs, and the later GitHub reconstruction must match it exactly. The operator later admits that exact reviewed head to one PR in the pinned registry, and the reader checks actual GitHub sources against the launched block. It contains GitHub-verified full before/after file bytes and dependency blobs, not just an asserted head. Select all relevant dependencies; ask the reviewer to identify omissions. The pointer schema is `paperclip.review-pointer/v1`, with `repository` and `entries` containing `pullRequest`, `headSha`, `admissionKey`, the same `dependencies`, and `dispositions`. Each disposition binds `sourceID`, `sourceVersion`, `bodySHA256`, `disposition`, `reason` and `evidence`. An initial report exposes unprocessed sources so they can be assessed without requesting another model call. A missing, malformed or unsupported pointer produces a visible `readiness_unknown` entry for every input candidate with a specific pointer subcode; it does not discard candidates or launch another review. Readiness output, like emitted source input, must be outside the trusted reader checkout (or stdout via `--output -`).

All emitters compare the device/inode of existing destination ancestors with the trusted checkout, so case aliases and symlinks cannot bypass the outside-checkout check. The inline v1/v2 writer accepts an existing single-link regular file or a new file under an existing external parent, and `--output -` writes to stdout. The Read emitter requires a new absolute directory under an existing external parent, resolves that parent to its real path before recording the corpus root, and never writes in `--check-only`; its assets are private, single-link and read-only. The operator must keep the filesystem stable between validation and writing; the check is not protection against a same-user filesystem race.

The operator/executor and filesystem are the trust boundary, as an instance administrator would be for server run records. An administrator or same-user process able to alter that boundary can fabricate evidence. Hashes do not authenticate a provider or prove isolation. This reader neither creates an authenticator nor claims cryptographic attestation. Run it from trusted adopted code, never let a PR execute or configure its own review admission.

The initial and final evidence snapshots compare the complete typed GraphQL status rollup, including legacy `StatusContext` rows and duplicate names. Check annotations are read from the same repository/check-run route at both snapshots, with every page and the declared count verified. GitHub's annotation response has no native annotation ID: the inventory uses the owning check-run ID, complete body digest and identical-body occurrence, preserving duplicates and all annotation levels for operator disposition. The private readiness report includes every received annotation body and its head/source/version binding. Missing, unreadable, incomplete or changing annotation evidence cannot establish readiness; notices are not automatically classified as harmless.

Keep public PR evidence to the reviewed head, actual model, verdict and report digest. Do not publish private journal paths, instance IDs, credentials or internal logs.

## Helping Other Contributors

Fixing up someone else's stalled or almost-there PR is **strongly encouraged**. If a contributor has done most of the work but ran out of time or got stuck, picking up their branch, polishing it, and getting it over the line is one of the most valuable things you can do here.

When you do:

- Give credit. Mention the original author in the PR description and thank them.
- Preserve their commits where reasonable — don't squash them out of existence.
- Be kind in comments and reviews. People put real effort into their PRs, even the ones that didn't quite land.

A culture where contributors help each other ship is worth more than any single PR. Be generous with thanks.

## Feature Contributions

We actively manage the core Paperclip feature roadmap.

Uncoordinated feature PRs against the core product may be closed, even when the implementation is thoughtful and high quality. That is about roadmap ownership, product coherence, and long-term maintenance commitment, not a judgment about the effort.

If you want to contribute a feature:

- Check [ROADMAP.md](ROADMAP.md) first
- Start the discussion in Discord -> `#dev` before writing code
- If the idea fits as an extension, prefer building it with the [plugin system](doc/plugins/PLUGIN_SPEC.md)
- If you want to show a possible direction, reference implementations are welcome as feedback, but they generally will not be merged directly into core

Bugs, docs improvements, and small targeted improvements are still the easiest path to getting merged, and we really do appreciate them.

## General Rules (both paths)

- Write clear commit messages
- Keep PR title + description meaningful
- One PR = one logical change (unless it's a small related group)
- Run tests locally first
- Be kind in discussions 😄

## Writing a Good PR message

Write all PR text in Simplified Technical English (ASD-STE100): use short sentences, one instruction per sentence, simple approved vocabulary, and the active voice.

Your PR description must follow the [PR template](.github/PULL_REQUEST_TEMPLATE.md). All sections are required. The "thinking path" at the top explains from the top of the project down to what you fixed. E.g.:

### Thinking Path Example 1:

> - Paperclip is the open source app people use to manage AI agents for work
> - There are many types of adapters for each LLM model provider
> - But LLM's have a context limit and not all agents can automatically compact their context
> - So we need to have an adapter-specific configuration for which adapters can and cannot automatically compact their context
> - This pull request adds per-adapter configuration of compaction, either auto or paperclip managed
> - That way we can get optimal performance from any adapter/provider in Paperclip

### Thinking Path Example 2:

> - Paperclip is the open source app people use to manage AI agents for work
> - But humans want to watch the agents and oversee their work
> - Human users also operate in teams and so they need their own logins, profiles, views etc.
> - So we have a multi-user system for humans
> - But humans want to be able to update their own profile picture and avatar
> - But the avatar upload form wasn't saving the avatar to the file storage system
> - So this PR fixes the avatar upload form to use the file storage service
> - The benefit is we don't have a one-off file storage for just one aspect of the system, which would cause confusion and extra configuration

Then have the rest of your normal PR message after the Thinking Path.

This should include details about what you did, why you did it, why it matters & the benefits, how we can verify it works, and any risks.

Questions? Just ask in #dev — we're happy to help.

Happy hacking!
