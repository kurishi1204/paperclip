# Native configured issue approval stage

The public `f22a490` implementation could create a configured issue execution approval stage, but a native worker run had no dedicated way to decide it. The generic approval catalog entry was not bound to that stage, while `call_api` correctly rejected lifecycle status mutations. This change adds `decide_issue_approval_stage` for the current standard-mode native run and a strict `POST /api/issues/:id/approval-stage-decisions` receiver.

The receiver accepts only a verdict, summary, and exact stage/revision/status-version/previous-decision preconditions. It verifies the run JWT, company, actor, current assignee, execution run, pending approval participant, and goal state before side effects and again under the issue transaction lock. It reuses the existing issue transition, comment, decision, activity, and wake path through an explicit server-only argument to the issue update handler. Legacy PATCH, Board review, QA review, and native completion review keep their existing contracts. Generic `call_api` cannot invoke the new receiver.

The tool reserves each attempt on the run before POST. A matching formal `issue_execution_decisions` row is its receipt after a lost response; an ambiguous response never causes another POST, even with a new call ID. A definite prewrite rejection is retained in history and permits a fresh request with a new call ID and current preconditions. Active goals or pending goal controls are rejected; a future change must define how those goals complete across an approval handoff.

Native finalization preserves an approval verdict only when the same run's reservation and original formal decision agree. It rechecks that source at commit, preserves any later worker status and lease, and releases only lease fields still owned by the deciding run. Workspace finalization failure retains its existing recovery priority.

This implementation is scoped to the configured issue execution stage. It does not decide ordinary company approvals or business adoption.
