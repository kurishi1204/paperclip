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

/** A previous document-capable provider episode needs an explicit owner decision.
 * Read only the server-stamped persisted source receipt; current agent config,
 * prose, exit codes and a missing write receipt cannot prove a write did not run.
 * A fresh explicitly admitted episode receives its own server stamp.
 */
export function hasSelfTaskDocumentReplayHold(run: { contextSnapshot?: unknown } | null | undefined): boolean {
  const context = run?.contextSnapshot;
  return context !== null && typeof context === "object" && !Array.isArray(context) &&
    (context as Record<string, unknown>)[SELF_TASK_DOCUMENT_CONTEXT_KEY] === true;
}
