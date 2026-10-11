# Dedicated Codex formal QA (plan v1 and implementation contract)

Scope: the existing company independent QA assignment, using the managed OpenAI subscription connection. Claude's observed quota failure and the owner's explicit Codex fallback authorization justify the replacement. This plan was prepared by Codex; it is not a Claude-generated plan. Code review, deployment, real review receipt and human business acceptance remain separate gates.

## Sequence

1. Select the dedicated QA entry before ordinary Codex workspace, skills, runtime tools and session setup.
2. Require the operator's absolute executable and SHA-256 seal, and the observed CLI version 0.154.0. Never resolve executable authority from agent PATH.
3. Copy only the managed provider credential into a disposable private HOME; configure one run-bound loopback Paperclip QA MCP server and the server's eleven QA tools. Remove the disposable HOME after the provider stops.
4. Verify all actual executors, including inherited child executors, rather than infer isolation from configuration flags or model-facing wrapper names.
5. Independently review the fixed implementation, adopt and deploy it, then use the existing COL17 assignment for formal QA. Read the server's issue revision, review receipt and stopped-run behavior separately. Human business acceptance remains pending until its owner accepts the result.

## Measured tool boundary

CLI 0.154.0 advertises nine `functions` and `collaboration` wrappers. These are not eleven QA tools. The `functions.exec` registry contains fifteen executors: eleven run-bound QA MCP calls, `apply_patch`, and three MCP resource methods. In a local fake provider/MCP proof all eleven QA callbacks executed, patch writes were rejected by the read-only sandbox, and all three resource methods were rejected as unsupported. Shell is not registered; `fetch`, `process`, `require` and `WebSocket` are unavailable in the code interpreter. A spawned child inherited the same executor registry and the same write/resource denials. Coordinator wrappers can therefore delegate computation but do not grant a host executor. The production MCP endpoint accepts only its QA methods and continues to enforce the existing actor/run/issue/revision/stop contract.

The operator pin is a deployment setting, not agent configuration. Missing, changed or symlinked executable seals stop before provider work. Upgrading the executable requires a new complete executor proof and pin. Flags are supplementary constraints, not isolation evidence. The local fake proof is not a real company QA receipt.

## Acceptance

Unit tests and executor fixtures establish only the adapter boundary. Formal QA requires the real assigned reviewer to obtain evidence and submit/read back a scoped review receipt. An exit-zero provider process without its terminal protocol event is failure. Ordinary worker output, successful research, authentication, installation and merge are not formal QA or business acceptance.
