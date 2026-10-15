<!-- Write all pull request text in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, simple approved vocabulary, and the active voice. -->

## Thinking Path

<!--
  Required. Trace your reasoning from the top of the project down to this
  specific change. Start with what Paperclip is, then narrow through the
  subsystem, the problem, and why this PR exists. Use blockquote style.
  Aim for 5–8 steps. See CONTRIBUTING.md for full examples.
-->

> - Paperclip is the open source app people use to manage AI agents for work
> - [Which subsystem or capability is involved]
> - [What problem or gap exists]
> - [Why it needs to be addressed]
> - This pull request ...
> - The benefit is ...

## Linked Issues or Issue Description

<!--
  Required. Pick ONE of the two paths below.

  (A) Issue exists — replace the placeholder below with your issue links.
      Tag each linked issue with `Fixes: #123`, `Closes #123`, or `Refs #123`.
      Include duplicates and closely related issues too.

  Only reference PUBLIC GitHub issues/PRs here. Do NOT paste internal,
  instance-local Paperclip references — ticket ids like PAPA-123 / PAP-224,
  /PAP/issues/... or agent://... links, or localhost/tailnet URLs. Other
  contributors cannot open them. See CONTRIBUTING.md → "No Internal Issue
  References".

  (B) No issue exists — describe the underlying problem here. Follow the issue
      template that fits your change. Open the matching file and copy its field
      labels into your description:
        • Bug:         .github/ISSUE_TEMPLATE/bug_report.yml
        • Feature:     .github/ISSUE_TEMPLATE/feature_request.yml
        • Adapter:     .github/ISSUE_TEMPLATE/adapter_request.yml
        • Enhancement: .github/ISSUE_TEMPLATE/enhancement.yml
        • Docs:        .github/ISSUE_TEMPLATE/docs_issue.yml
      An automated check reads the literal bold labels AND the content under
      each label. Keep at least three of these labels, each alone on its own
      line, and write real content under each. A label with only the bare "-"
      placeholder does not count, and the check fails.

  See CONTRIBUTING.md → "Link Issues or Describe Them In-PR".
-->

-

## What Changed

<!-- Bullet list of concrete changes. One bullet per logical unit. -->

-

## Verification

<!--
  How can a reviewer confirm this works? Include test commands, manual
  steps, or both. If GitHub Actions is disabled by the repository owner, link
  the exact-head local receipt, base/head test-ID comparison, and machine-readable
  failure/skip inventory. List the required gates and results from the recorded
  base workflow and repository rules. Compare collected test IDs with the
  recorded base SHA; for a baseline exception, link a full base-run receipt
  under the same runner conditions. If the head or base tip moves before merge,
  update the branch and refresh the evidence, independent review, and human-owner
  decision for the new head/base pair.
  State how the test identity was isolated from publishing credentials. A
  baseline full-suite failure needs the same evidence whether Actions is enabled
  or disabled. Include the independent review and owner decision required by
  CONTRIBUTING.md. Record each reviewed gate substitution. Never mark a failed
  test or disabled check green.
-->

-

## Risks

<!--
  What could go wrong? Mention migration safety, breaking changes,
  behavioral shifts, or "Low risk" if genuinely minor.
-->

-

> For core feature work, check [`ROADMAP.md`](ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

## Model Used

<!--
  Required. Specify which AI model was used to produce or assist with
  this change. Be as descriptive as possible — include:
    • Provider and model name (e.g., Claude, GPT, Gemini, Codex)
    • Exact model ID or version (e.g., claude-opus-4-6, gpt-4-turbo-2024-04-09)
    • Context window size if relevant (e.g., 1M context)
    • Reasoning/thinking mode if applicable (e.g., extended thinking, chain-of-thought)
    • Any other relevant capability details (e.g., tool use, code execution)
  If no AI model was used, write "None — human-authored".
-->

-

## Checklist

<!-- Leave future checks unchecked at PR creation. Update with exact-head evidence
     before requesting merge; a checked box claims the condition is met now.
     If the head or base tip changes, uncheck the required-tests, base/head
     inventory, full-suite, independent-review, human-owner, and Greptile boxes
     below until evidence and decisions are refreshed for the new pair. -->

- [ ] I have included a thinking path that traces from project context to this change
- [ ] I have specified the model used (with version and capability details)
- [ ] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [ ] I have searched GitHub for duplicate or related PRs and linked them above
- [ ] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [ ] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [ ] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [ ] I have run required tests locally; PR-specific tests, lint, typecheck, build, and required static gates pass
- [ ] I have added or updated tests where applicable
- [ ] I have updated relevant documentation to reflect my changes
- [ ] I have considered and documented any risks above
- [ ] For local receipts or baseline exceptions, I have compared base/head test IDs and recorded every failure and required skip, including collection or import errors
- [ ] The full suite passes or each baseline failure and required skip has the exact-head/base evidence required by CONTRIBUTING.md; I have not called a disabled or failing gate green
- [ ] An independent reviewer has validated the exact-head/base receipt, gate substitutions, and immutable input hash
- [ ] The human owner has accepted this full head SHA, full base-tip SHA, immutable input hash, independent-review record link, exception list (or `none`), intentional-skip list (or `none`), base-to-head test-ID removals/renames (or `none`), gate substitutions (or `none`), additional-gate not-applicable decisions (or `none`), and any base-race residual risk in a separate PR comment; only the human owner checks this box
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [ ] I will address all Greptile and reviewer comments before requesting merge
