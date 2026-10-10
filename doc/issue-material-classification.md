# Issue material classification

This page is the entry point for the versioned ledger at
[`issue-material-classification-v1.json`](issue-material-classification-v1.json).
The ledger classifies every schema table with a direct `issues.id` reference or
an explicit issue ID column. The check derives the denominator from schema
source, then compares complete table-name sets. Its output supplies the counts;
the document does not maintain a second inventory.

- `cas`: the current native issue requirement snapshot includes the table.
- `separateEvidence`: the table is outside that snapshot. A consumer that relies
  on it needs an independent version or proof. Classification does not assert
  that such proof already exists.
- `hold`: the table can contain issue material that the current snapshot omits.
  A dependent execution must stop until it is covered or explicitly excluded.

The scope is direct schema references. Linked `documents` and `assets` are
included by the current snapshot and triggers, but are not extra entries in
this direct-reference denominator. Indirect conversation or approval content
also needs its own decision when used as execution input.

Run `pnpm check:issue-material-classification` to validate schema coverage and
`pnpm test:issue-material-classification` for fault cases. Both commands run in
trusted pull-request CI.
