# Bounded native read-result delivery

An oversized native read result must fail explicitly without becoming an unknown write. The existing durable command limit and all authority checks remain unchanged.

The shared protocol catalog is the authority for sideEffectClass=read. Only when such an operation has resolved and queueCommand rejects its result as command_payload_too_large before append/send does the controller queue one bounded error for the original call. It includes the omitted result byte count and digest, omits the body, and directs the caller to an existing narrower/paginated/artifact read path. It is an error, not a successful read response, and it does not repeat the operation.

The original input, source event, correlation and command-result acknowledgement remain required. Once the explicit error is durably delivered, normal provider drain and suspension can proceed; an unfinished read response must not poison later work. Oversized write results, unknown operations, failed persistence, a full journal and uncertain dispatcher failures retain the original fail-closed quarantine and outcome-reconciliation behavior. There is no automatic write replay, permission change or relaxed process-cleanup proof.

Verification uses the real authenticated encrypted PRP channel: an oversized synthetic revision read returns the bounded error, an ordinary following write runs once, both deliveries settle, and reopening the controller does not redispatch. Negative tests retain quarantine for a write and an uncatalogued operation. This change does not claim that all history fits a single response or that a tool error is business acceptance.
