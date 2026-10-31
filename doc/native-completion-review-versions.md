# Completion reviews after a saved writer continuation

A writer can receive another ordinary comment while its completion review is
queued. If that continuation finishes first, its saved result needs a review
of its own. Keeping the old card as a governance gate advances the issue's
status decision but invalidates the queued review assignment. Neither result
then has an executable review path.

The native finalization reconciler retires that obsolete request only when the
latest applied decision is a pending interaction gate, the same writer has
successfully committed a later result under the current completion contract,
and that result explicitly requests the same independent agent reviewer.
The old card must be a system-created native completion review, bound through
its original status-decision effect. No issue execution may be active. Any
attempt to execute the old review must have been cancelled before dispatch
with `issue_assignee_changed`; an attempt that began execution prevents this
automatic handoff.

Retirement records a withdrawal, never an approval. The activity record links
the old request, current status decision, and saved replacement result. The
old results, decisions and cancelled run stay unchanged. A durable retirement
marker lets the usual reconciler reassess the current saved result after a
restart and create one new, version-bound review request. It does not rerun
the writer or replay provider/tool calls. Repeated reconciliation does not
create additional cards or wakes.

Human approvals, execution-stage gates, answered reviews, a changed assignee
or contract, failed workspace finalization, and reviews that have begun work
remain governed by their existing rules. Review assignment still requires
the issue's current status decision and projected status version to match;
the handoff does not relax that authority check or the independent-review
policy.

The real-PostgreSQL cases in `native-status-arbiter-corpus.test.ts` exercise a
writer result, its ordinary continuation, the obsolete queued review, normal
reconciliation, restart after retirement, and preservation of the remaining
authorities. Product acceptance additionally requires observing the named
reviewer resolve the current saved document in the running service.
