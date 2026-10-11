# Commander reservation and board preparation

## Observed failure

On the adopted first cycle, a new task started through its normal system assignment before the commander selected it. The real worker result is valid research, but it is not commander dispatch proof. Disabling and later enabling demand wakes is not a dispatch reservation.

## Contract

The board first configures an admission for the predicted next revision of one existing, unassigned backlog task. The new normal API route compares issue revision, status version, description hash, company, commander policy, worker and active runs under issue and commander row locks. It changes that task to TODO with the admitted worker, writes one audit event, and creates no assignment wake. No task or run is created by preparation.

An admitted TODO task is reserved in the common enqueue transaction. Other wake sources get a durable skipped receipt. Expiry or a body edit cannot release the task to an ordinary wake. The board must remove its admission to release the reservation. A valid commander guard still follows normal enqueue; it rechecks the active parent and exact policy and task state. Independent QA and owner approval follow separately.

## Commission

Use one suitable existing company backlog task. Do not repeat the completed initial business task. Keep worker settings stable. Prepare once with board CAS, then enable the commander timer and observe a source=timer commander Run, its exact dispatch receipt, worker execution, independent QA and owner acceptance. A skipped normal assignment and a passed fixture are separate evidence from that live sequence.

## Model

Claude Code Opus 5.5 returned the weekly quota limit in the current session. The user approved Codex fallback. Codex performs this batch; exact current model ID is not available in tool context. Independent review occurs after the full implementation and meaningful old-red/new-green tests.

## Normal result handoff

The real Hermes run returned a verified public report, but the task had no typed next path. Legacy disposition repair therefore reran the public search immediately and failed. An admitted task may now include an explicit board-granted independent reviewer, human owner and fixed document key. Board preparation binds the complete canonical admission hash and verifies assignment rights for both worker and reviewer.

Only a bounded Hermes run from the actual commander admission wake may capture a server-owned claim immediately before execution. Exact current issue revision/status version, description hash, parent run, current admission, cancellation, QA isolation and distinct identities are revalidated before a transaction fixes the report, source receipt, document revision and pending independent review stage. It does not approve either stage. Worker Paperclip API/tool permissions are unchanged.

The same transaction stores the fixed handoff receipt on the source Run. Normal QA enqueue uses its unique source Run key. Existing startup and periodic stranded-issue reconciliation also reads the current pending stage and byte-matching document receipt, so a crash between commit and enqueue resumes QA without another Hermes turn. A changed stage, edited document, changed admission, paused reviewer or cancelled source never becomes an implicit retry. Failure evidence remains visible.
