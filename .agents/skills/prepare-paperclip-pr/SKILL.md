---
name: prepare-paperclip-pr
description: Prepare a Paperclip branch for PR with commits, template body, and checks.
---
# Prepare Paperclip PR

The standard Paperclip procedure for turning branch work into a reviewed,
green pull request against `paperclipai/paperclip` master. Apply it once per
PR (if a task splits a branch into several PRs, run the whole procedure for
each one).

## 0. Preconditions — worktree safety

* Do all PR work in a **git worktree** on a dedicated branch. The main
  `~/paperclip` checkout typically runs the live Paperclip server — never
  check out branches there. If you are already on a worktree/branch, verify it
  (`git rev-parse --git-dir`, `git branch --show-current`) and proceed.
* If the main checkout is unexpectedly off `master`, fix that first without
  losing work (usually: move that branch's work into a worktree).
* Confirm which remote/ref you are targeting (normally `master` on the
  `paperclipai/paperclip` repo; the task may name a specific remote such as
  `origin` or `public-gh`).

## 1. Commit everything — lose no work

* Make **logical commits** of all uncommitted changes before anything else.
  Do not stash and forget; do not leave files behind. If commits are missing,
  make them.
* Commit messages must end with exactly:
  `Co-Authored-By: Paperclip <noreply@paperclip.ing>`

## 2. Get changes cleanly on top of master

* Fetch the target remote and rebase (or otherwise replay) your branch on top
  of the target master so the PR has no merge conflicts.
* Re-verify after rebase: build/tests relevant to the change still pass at
  whatever depth the task warrants.

## 3. Guardrails checklist (every PR)

* **Never commit `pnpm-lock.yaml`** — the repo has actions that manage it.
  If it is already in a commit, rewrite/drop that change before pushing.
* **Never change `.github/workflows/*`** unless the underlying commit was
  explicitly about that and the task calls it out.
* **No design screenshots / wireframe images** committed to the repo unless
  they are genuinely part of the work product.
* **Migrations**: numbered incrementally with no conflicts against master. If
  master moved and took your number, renumber on top. Make migrations
  **idempotent** so users who already applied the old number are safe.
* Keep PRs focused and reviewable. For `kurishi1204/paperclip`, the Greptile-specific 100-file limit is advisory; split by coherent changes. Other target repositories retain their existing under-100-file Greptile limit.

## 4. Open the PR

* Follow the target repository root `CONTRIBUTING.md` for the PR title, message format, and issue description. For `kurishi1204/paperclip`, use that fork's adopted contract. The upstream reference https://github.com/paperclipai/paperclip/blob/master/CONTRIBUTING.md applies to upstream targets, not as an override of the fork contract.
* Push the branch and open the PR with `gh`.
* Record the PR URL immediately — every report must include URLs to every PR.

## 5. Review loops

For `kurishi1204/paperclip`, load the target fork's `CONTRIBUTING.md`, not the upstream URL in section 4. Apply its Review Gate using trusted adopted reader code. Run relevant CI, then an independently authorized fresh-session Opus5.5 review of the actual final source block and relevant dependencies. Use operator-admitted CLI journal evidence outside the PR checkout. Readiness never certifies itself from a PR-body claim or a model name. Unknown evidence remains unknown. The trusted registry must bind a non-empty actual `implementationSessionID`, and the reader must verify that it differs from the launched review session; operator admission remains responsible for that implementation record’s provenance. Report only public-safe head/model/verdict/report-digest fields and the actual optional Greptile state.

Do not automatically request Greptile, pay for a review loop, create company work or launch a model because a score is absent. Process all actually received findings. Model calls and adoption retain their own existing authorization; this skill adds none. The legacy steps below apply only to other target repositories.

* Run the **/greploop** company skill: trigger Greptile review, address its
  comments, push, and repeat until Greptile gives **5/5 with zero unresolved
  comments** (max 20 turns). Do not stop early while turns remain.
* Then run the **/prcheckloop** company skill and address any verification /
  CI failures you can.
* RUN GREPTILE UNTIL IT GETS TO 5/5 - DO NOT STOP UNTIL GREPTILE IS 5/5, all
  tests pass, all verification checks pass, and there are no merge conflicts.

## 6. Report back and hand off

* Comment on the driving task: what you did, the PR URL(s), the worktree path
  (use `~` for home), and check status. For this fork, report actual Greptile availability and findings; include a score only if the provider actually returned one. Other repositories retain their existing score-report rule.
* Create a `pull_request` work product for each opened PR (plus `branch` /
  `commit` work products where the branch or a commit is itself the handoff).
* If the task requires follow-up per PR (e.g. sub-issues per PR), create them
  as the task directs and link them.

## Hard rules

* Never lose work: no orphaned stashes, no dropped files, no force-pushes
  that discard commits.
* Always post the URLs to every pull request you created.
