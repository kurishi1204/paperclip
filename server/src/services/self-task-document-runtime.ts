/** Server-owned receipt, never an authority supplied by a wake payload. */
export const SELF_TASK_DOCUMENT_CONTEXT_KEY = "paperclipSelfTaskDocumentToolsOnly";

export function isSelfTaskDocumentRuntime(
  adapterType: string,
  config: Record<string, unknown>,
): boolean {
  return adapterType === "claude_local" && config.selfTaskDocumentToolsOnly === true &&
    config.qaReviewToolsOnly !== true && config.commanderCycleToolsOnly !== true;
}

/** localApiUrl must come from the bound listener, not the public API setting. */
export function selfTaskDocumentMcpServers(input: {
  localApiUrl: string | null;
  authToken: string | null | undefined;
  hasIssue: boolean;
}) {
  if (!input.localApiUrl || !input.authToken || !input.hasIssue) return [];
  return [{
    name: "Paperclip projects",
    url: `${input.localApiUrl}/api/mcp/project-tools`,
    token: input.authToken,
    connectionId: "paperclip-project-tools",
  }];
}

type DocumentRunEvidence = {
  id?: unknown; companyId?: unknown; agentId?: unknown; wakeupRequestId?: unknown;
  controllerBootId?: unknown; runtimeMode?: unknown; status?: unknown; errorCode?: unknown;
  processPid?: unknown; processGroupId?: unknown; processStartedAt?: unknown;
  externalRunId?: unknown; nativeSessionId?: unknown; contextSnapshot?: unknown; resultJson?: unknown;
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Only the owning executor may persist this receipt after preparation cleanup.
 * Old bootstrap/exit-code history and wake payloads cannot establish non-entry.
 */
function hasSettledSelfTaskDocumentSetup(run: DocumentRunEvidence): boolean {
  const context = record(run.contextSnapshot);
  const recovery = record(record(run.resultJson).executionRecovery);
  const proof = record(recovery.selfTaskDocumentPreProvider);
  if (run.runtimeMode !== "legacy" || run.status !== "failed" || context.qaDecisionId != null ||
      !["workspace_git_scan_timeout", "workspace_git_scan_saturated"].includes(String(run.errorCode)) ||
      recovery.kind !== "bootstrap" || recovery.providerWorkStarted !== false ||
      proof.schema !== "paperclip.self-task-document-pre-provider/v1" ||
      typeof proof.cleanupSettledAt !== "string" || !Number.isFinite(Date.parse(proof.cleanupSettledAt)) ||
      [run.processPid, run.processGroupId, run.processStartedAt, run.externalRunId, run.nativeSessionId]
        .some(value => value !== null)) return false;
  const bindings = { companyId: run.companyId, agentId: run.agentId, runId: run.id,
    wakeupRequestId: run.wakeupRequestId, controllerBootId: run.controllerBootId, issueId: context.issueId };
  return Object.entries(bindings).every(([key, value]) =>
    typeof value === "string" && value.length > 0 && proof[key] === value);
}

/** A previous document-capable provider episode needs an explicit owner decision.
 * Read only the server-stamped persisted source receipt; current agent config,
 * prose, exit codes and a missing write receipt cannot prove a write did not run.
 * A fresh explicitly admitted episode receives its own server stamp. An exact
 * post-cleanup pre-provider setup receipt permits only the existing retry lane.
 */
export function hasSelfTaskDocumentReplayHold(
  run: DocumentRunEvidence | null | undefined,
): boolean {
  const context = run?.contextSnapshot;
  return context !== null && typeof context === "object" && !Array.isArray(context) &&
    (context as Record<string, unknown>)[SELF_TASK_DOCUMENT_CONTEXT_KEY] === true;
}

/** Only the bounded setup-retry lane may use this narrower exception. */
export function hasSelfTaskDocumentSetupRetryHold(run: DocumentRunEvidence | null | undefined): boolean {
  return hasSelfTaskDocumentReplayHold(run) && !hasSettledSelfTaskDocumentSetup(run!);
}
