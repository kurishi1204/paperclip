# Settled ACPX task continuation across registered file copies

A normal task resumes after an independent document review. The server builds
a new private instruction working copy for the new run. The old ACPX attachment
check treats that path, including its occurrence in generated instructions, as
a changed immutable profile and rejects the continuation before a prompt.

The repair compares registered copy locations by their role, retaining exact
instruction content, bundle and skill identities, prompt and unknown policy
fields. It admits relocation only across an authenticated new run of the same
settled provider session. The existing model, permission, workspace, active-turn,
pending-event and provider-exit checks remain in force. Cursor's separate
authenticated instruction contract is unchanged.

Comparison tokens are local only. The original current descriptor and its
current file grants are persisted, and the existing per-turn instruction
supplies the current AGENT_HOME. No checkpoint edit, session reset, employee
change, permission change or schema migration is required.

The regression uses a qualified Claude profile and synthetic registered paths.
It fails before the repair. The repaired fixture checks successful relocation,
preservation of current paths, rejection of same-run relocation, malformed roots,
changed instructions and unknown policy, plus no provider launch during admission.
Runner-core checks run offline. Natural PR CI and a same-head independent review
are required before adoption. Actual employee continuation remains a separate
production acceptance; code or test success does not claim that acceptance.
