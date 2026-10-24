# Lossless review-source v2: adoption candidate

Status: **private candidate, not adopted**. This document records a proposed
change to the review-source representation and its admission contract. The
current adopted reader remains v1 until this exact candidate is independently
reviewed under v1, passes current-head CI and is accepted by maintainers. V2
cannot certify its own installation. Neither version replaces an implementation
review, required CI, findings dispositions or maintainer adoption. No template,
workflow, callee, permission or catalog change is proposed.

## Purpose and scope

Measure whether representing modified source once can reduce the fixed inline
corpus without losing before bytes. Read tools and compaction are not used as a
capacity workaround. Token counts and model context fit remain **unknown**.
This is not an instruction to send an unsupported employee review or to use an
API credential, authentication extraction or paid token-count probe.

The candidate retains the codec/emitter and adds explicit v2 journal admission,
related tests, private report labeling and synchronized contributor/skill text.
The existing v1 entry, launcher profile and readiness decision remain valid.
Default emission is still v1. Explicit v2 output
uses the existing GET-only emitter and output-path boundary:

```sh
node .agents/skills/pr-gardening/scripts/check-readiness.mjs \
  --emit-review-input <existing-PR> --repo kurishi1204/paperclip \
  --source-schema v2 --review-dependencies <relevant-paths> \
  --output <existing-outside-checkout-parent>/source-v2.txt
```

This command is a candidate interface, not production admission. The local tests
use a fake `gh`; no GitHub operation was performed for the measurement.

## Representation and reconstruction

The new source schema is `paperclip.fork-review-source/v2`:

- Repository, head/tree, base/merge-base and path/status identities are retained.
- Added files contain whole after; removed files contain whole before.
- Modified, renamed and copied files contain whole after plus before path/blob
  identity and `paperclip.exact-reverse-line-diff/v1`.
- Every selected dependency remains a whole blob.
- `logicalSourceSHA256` binds the complete reconstructed canonical v1 object.

The reverse diff is ordered data: an after-line start, count of after lines to
replace and the exact before text. Trusted code generates it from verified Git
blob contents. Deterministic patience anchors retain unchanged regions; a region
without useful unique anchors is kept whole. Minimal diff size is not promised.
No candidate-supplied patch command, shell or external patch program is run.

Restoration applies data operations, verifies both Git blob SHA-1 values over
`blob <byte-length> NUL <bytes>`, checks the logical SHA-256 and requires the
canonical generated diff. Unknown keys/schema, mixed whole-before/diff forms,
invalid ranges, redundant edits, changed bytes or mismatched identities fail.
The block parser rejects v1, mixed/duplicate blocks and malformed JSON instead
of choosing a fallback. The parsed JSON body must be the exact canonical
serialization, rejecting duplicate schema keys instead of JSON last-key-wins. UTF-8, CRLF, final-newline state, empty files and rename
paths are preserved; invalid UTF-8 representations and NUL source remain
unsupported. The explicit v2 producer preserves a UTF-8 BOM. The default v1
producer's existing TextDecoder behavior is deliberately unchanged.

Mechanically reconstructible before is different from placing whole before in
the launched text. Admission of that meaning is explicit in this candidate: registry kind `trusted-cli-journal/v2` must pair with `sourceSchema: paperclip.fork-review-source/v2`. The reader reconstructs and hashes the logical v1 source before accepting the launched block. Old `trusted-cli-journal/v1` entries require no `sourceSchema` field and keep the original full-before/full-after semantics.

## Local evidence

The original prototype related Node suite passed **172 tests, 0 failures, 0 skips**. The current candidate related Node suite passes **184 tests, 0 failures, 0 skips**, including v1 controls and explicit v2 admission/rejection cases. Tests cover valid v1 behavior, byte-exact round trips,
multiple separated edits, UTF-8/BOM/CRLF/no-final-newline, empty/added/removed/
renamed/copied files, malformed data, unsupported schemas and explicit emitter
behavior. An additional disposable real Git history independently exercises
added/removed/renamed paths and fifteen actual text/dependency blobs. A valid-looking v2 journal is still rejected by the unchanged v1
admission. The old adopted implementation fails the two targeted v2 acceptance
cases: codec absent, and v2 flag still emitting v1.

An initial CLI-test helper omitted the existing `realpathSync` convention on
macOS. That let Node exit without entering `main`; its raw failure was retained
and the fixture corrected before accepting the RED/GREEN evidence. No product
fix or acceptance claim is based on that harness failure.

The existing fixed11-file employee corpus with the same16 named dependencies
was reconstructed locally. All22 before/after and16 dependency blobs match both
an independent reverse-order splice plus `git hash-object`, and their actual
fixed Git blobs. Measurements include canonical JSON framing/escaping:

| Representation | Bytes |
| --- | ---: |
| Existing whole-before/after v1 block | 4,726,097 |
| Whole-after + exact reverse diff + whole deps v2 block | 2,515,833 |
| Reduction | 2,210,264 |

The v2 payload includes2,190,450 raw whole-after bytes,6,909 canonical diff bytes
and231,401 raw dependency bytes, plus framing, metadata and JSON escaping.
The original full logical source SHA-256 is reproduced; no source is omitted.
These byte results do not establish a token count, fit or provider acceptance.

## Logical units, not completed PR splits

The eleven changed paths partition into these code/test responsibilities. Each
size below retains the same16 named dependencies for a comparable calculation:

| Logical unit | Changed paths | v2 bytes |
| --- | ---: | ---: |
| Bounded self-task document API, fixed revision and no-replay receipt | 5 | 1,007,874 |
| Native Claude opt-in and actual-listener isolation | 4 | 1,631,346 |
| QA binding to the exact saved revision | 2 | 360,725 |

The latter units exercise the document path from the first. These are byte and
responsibility partitions only, not independently complete reviews of the
current head. Actual PR separation would require coherent bases, relevant
cross-unit dependencies, normal CI and exact-head reviews. No PRs, partial
admission or changes to the original eleven-path candidate were made.

## Candidate admission and display

The pinned operator registry keeps schema `paperclip.operator-review-registry/v1`.
Only its explicit v2 entry kind plus exact source schema admits a v2 block. The
reader requires one complete block, rejects mixed or duplicate blocks, verifies
the canonical body and every restored Git blob, and binds the reconstructed
logical v1 object with the existing `sourceInputSHA256` field. All current
executor, session, first-party model, tools-none, strict GO, CI, findings and
branch-protection checks remain. Unknown schemas and damaged source stay
invalid; there is no v1 fallback. The private report prints the source schema
and evidence kind (`inline-v1-whole-source` or
`lossless-v2-reconstructed-source`). V2 byte reconstruction does not establish
model context fit or semantic understanding.

This candidate's implementation itself must be reviewed through the adopted
v1 reader. The v2 path cannot act as an authority to approve its own change.

## Conditions before any adoption

1. Maintainers decide whether this representation is an acceptable policy change.
   Review this candidate under the existing trusted v1 path; it cannot admit its
   own installation. Its local pass is not an independent GO or remote CI.
2. If selected, independently verify the explicit registry `sourceSchema`/source-hash contract, deterministic trusted generation and mixed-format rejection in admission, plus CONTRIBUTING, skill and private report labeling. Missing/unknown evidence remains invalid.
3. Reconstruct the actual final corpus through the selected trusted entry,
   confirm dependency sufficiency and obtain authorized independent review,
   exact-head CI, findings dispositions, required approvals and protection.
   Token/context fit remains unmeasured; reduced bytes alone cannot certify it.

No provider, GitHub write, company Task/Run, merge, deployment or production
configuration operation is authorized by this proposal.
