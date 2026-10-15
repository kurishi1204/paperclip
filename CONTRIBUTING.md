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
- Verification satisfies [Tests Must Pass](#tests-must-pass) and [Paperclip Gates Must Pass](#paperclip-gates-must-pass)
- Greptile score is 5/5 with all comments addressed
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
  - Verification satisfying [Tests Must Pass](#tests-must-pass) and [Paperclip Gates Must Pass](#paperclip-gates-must-pass)
  - Greptile score 5/5 with all comments addressed
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

Run the required tests locally before requesting merge. PR-specific tests, lint,
typecheck, build, and other required static gates must pass. A full-suite failure
may receive only the baseline exception below, regardless of whether GitHub
Actions is enabled. Do not describe a failed or unfinished test run as passing.

### Telemetry Changes

This repo has three separate data paths: Telemetry, Observability, and the run log. See rule 7 in `AGENTS.md` for the full definitions and the review level each path needs.

If your change adds, removes, or modifies emitted telemetry events, update the [Telemetry Data Contract](packages/shared/src/telemetry/README.md) in the same PR. Keep clients emitting raw dimension values and avoid documenting or relying on private delivery details. If your change adds, removes, or modifies an OpenTelemetry span or span attribute, keep the change inside the closed span-attribute allowlist in `packages/adapter-utils/src/acpx-engine/startup-timing.ts`. If your change adds or modifies a run-log event, update `doc/run-log-events.md` in the same PR.

### Paperclip Gates Must Pass

Run all Paperclip gates (lint, typecheck, tests, build, and other required checks).
PR-specific tests, lint, typecheck, build, and other required static gates must
pass before merge. A full-suite failure may receive only the baseline exception
below. A red required GitHub check still blocks merge under branch protection.

For every PR, inventory the applicable gates from the recorded base SHA's
`.github/workflows/` and repository rules, whether Actions is enabled or not.
At minimum include `pnpm -r lint`, `pnpm typecheck`, `pnpm build`,
`pnpm test:run`, `pnpm check:node-version`, `pnpm check:module-boundaries`,
`pnpm check:issue-material-classification`, and
`node scripts/check-no-git-push.mjs`; include `pnpm check:token-gates` for UI
changes and any other applicable check in that base workflow. Record each
command's result. None of the minimum gates above can be marked not applicable.
For additional gates, record a reviewed reason when a gate does not apply and
include that decision in the human owner's PR decision. An unknown or omitted
gate blocks merge. A missing root script is not a passing gate. The author may
propose a checked-in workspace command, but the independent reviewer must
confirm that it covers the same gate and record the command mapping. The human
owner must name each accepted substitution in the owner decision. Until then,
the gate is unresolved and blocks merge.

Freeze evidence against both the full PR head SHA and the current PR base-tip
SHA. Before collecting evidence, require
`git merge-base --is-ancestor <base-tip> <head>` to succeed; otherwise update
the branch onto the current base first. Record that pair in the verification
receipt and independent-review record, whether Actions is enabled or disabled.
Immediately before merge, the
merger must again confirm the current base tip is an ancestor of the accepted
head, then read the live PR head and base tip and compare both with the
accepted pair.
If the base moved, update the branch onto the current base. If either SHA
changed, rerun the applicable gates and base/head test-ID comparison, obtain
a new independent review, and obtain a new human-owner decision for the
resulting pair. Do not use an auto-generated merge or squash commit as an
alternative to refreshing stale evidence. Do not rely on auto-merge unless it
revalidates both SHAs immediately before merging. Merge with
`gh pr merge --match-head-commit <accepted-head>` after this comparison, so a
concurrent head push cannot invalidate the accepted evidence.

For an owner-controlled fork where the repository owner has disabled GitHub Actions,
the owner may use fixed, local verification evidence instead of the missing Actions
check. This changes the check transport only. It does not enable a test-failure
exception. When Actions is enabled, all required Actions checks still apply.
The receipt's base SHA is the PR base-tip SHA recorded above. A still-required
GitHub check must be satisfied by its configured source; local evidence cannot
turn a red or missing required check green. Changing required checks is a
separate owner-controlled repository setting decision, recorded on the PR.
Do not use an administrator or ruleset bypass to merge around an unsatisfied
required check. Make any required-check change as a recorded owner decision
before merge.

A PR that changes these verification rules is governed by the policy at its
recorded base, not by its proposed head text. If disabled Actions makes a base
requirement impossible, the human owner must record an explicit transition
decision on that PR, including the affected check and accepted alternative,
before that alternative can be used. The author and reviewer cannot certify
their own policy change under the proposed new rule.

For every local verification receipt, and for every baseline exception even
when Actions is enabled, the PR must:

1. Link a receipt for the exact PR head and recorded PR base SHA. Record the
   runner identity, executing OS UID/GID, image digest when an image is used,
   tool versions, relevant environment/configuration hashes, test-data hashes,
   commands,
   exit codes, collected test IDs and outcomes, test counts, and log hashes.
   Include negative credential-isolation probes run under the tested OS identity:
   use a verified installed client or an actual API request to show that
   authenticated access fails, and show that configured publishing credential
   paths are unreadable. A missing client is not a successful denial probe.
   Record probe exit codes and redacted outputs without disclosing secret values.
   Collect the base test IDs under the same conditions for comparison. If a
   baseline exception is claimed, also link a full base-run receipt with the
   same fields. Retain the exact hashed artifacts for independent review.
   Publish only redacted
   copies or artifact locations that do not expose credentials or private host
   data; record the redacted copy's hash separately from the retained original.
   Compare the collected test IDs between base and head. Any test ID present on
   base but missing, renamed, focused, or excluded on head blocks merge unless
   the PR intentionally changes it and the independent reviewer and owner accept
   that exact-head change. Attach a machine-readable
   inventory of every failed and skipped test, including collection and import
   errors, with the reason and whether the skip is required or intentional.
   Run the full suite, PR-specific tests, lint, typecheck, build, and all
   applicable required static gates to completion. The PR-specific tests and
   gates outside the full suite must pass. Execute the
   tested PR code under an identity that cannot read GitHub or Paperclip
   publishing credentials; clearing environment variables alone is insufficient.
2. Treat tests added or changed by the PR, and tests that exercise changed behavior,
   as PR-specific. Treat a disputed test or gate classification as required until
   independent review resolves it. An intentional platform skip must have the
   same test ID, skip reason, and triggering condition on the recorded base SHA
   under the same runner, tool versions, environment, and test data. List each
   intentional skip in the human owner's decision even when no exception is
   needed. Otherwise treat it as a required-test skip.
3. Have a reviewer who did not author the change or prepare its evidence,
   including through another session of the same agent, validate the receipts.
   An independent reviewer must be a human or a different model family from
   the author; another session or harness with the author's model family does
   not qualify. Record author and reviewer model families when AI is used.
   The reviewer must validate the base/head test-ID comparison, credential
   isolation, complete gate inventory, and classifications. Record the
   reviewer's human identity or model/service
   version, full head and base-tip SHAs, immutable input hash, result, and safe
   artifact locations on the PR. The human repository owner must separately
   comment with the same full head and base-tip SHAs, the exact accepted-exception
   list (or `none`), each intentional skip (or `none`), each accepted gate
   substitution (or `none`), and each additional-gate not-applicable decision
   (or `none`) before merge. The immutable input hash is SHA-256 of a retained
   manifest listing the full head/base pair and every original receipt, log,
   test-ID inventory, and failure/skip inventory by path, byte size, and SHA-256.
   Keep both the manifest and its listed bytes available to the reviewer.
   An agent using the owner's account must not post or prepare a final owner
   acceptance comment, check its PR box, or merge. The human owner must perform
   the acceptance action. A changed head or base requires new evidence, review,
   and a new human-owner decision.

### Baseline Full-Suite Exceptions

This exception is available under the same conditions whether Actions is enabled
or disabled. It never overrides a required GitHub check or branch protection.
The head/base freeze, live pre-merge comparison, test-ID comparison, and
independent review above apply to every exception. For each full-suite failure
or required-test skip, run the recorded PR base SHA under the same runner
conditions, tool versions, environment, and test data. For a persistent runner,
use the same runner installation. For ephemeral runners, record matching
immutable image digests, OS/architecture, toolchain, configuration, and test-data
hashes for both runs. If equivalence cannot be proven, no exception is available.
A matching failure needs the same test ID and failure signature (assertion or error class
and stable message). A matching skip needs the same test ID and skip reason.
Import, collection, hook, and worker failures cannot receive the baseline
exception, even if a runner gives them a file-level ID.
The independent reviewer must inspect the changed code path and explain why the
result is a pre-existing baseline problem rather than a regression. A match alone
is not enough. If that causal explanation is unknown, do not grant the exception.
Map every failure and required skip to its evidence, even when several share one
cause. Keep the full suite marked **failed with accepted exceptions**. Never
call it green. The human owner must accept the exact list and head/base pair in
the PR record.

Mark Actions as **disabled**, and a failing full suite as **failed with accepted
exceptions** when those states apply. Never label either one green. These rules do
not bypass a failed PR-specific test, lint, typecheck, build, another required
static gate, an unresolved regression, or the Greptile review requirement.

### Greptile Review

We use [Greptile](https://greptile.com) for automated code review. Your PR must achieve a **5/5 Greptile score** before it can be merged, with:

- **No open P2 (or higher) comments**
- **No open recommendations**
- **No open follow-ups**

We hold the bar high here on purpose — we want code quality to be as high as possible. If Greptile leaves comments, fix them (or, if a comment is wrong, reply explaining why) and request a re-review.

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
