import { describe, expect, it } from "vitest";
import { hasSelfTaskDocumentReplayHold, hasSelfTaskDocumentSetupRetryHold, SELF_TASK_DOCUMENT_CONTEXT_KEY, isSelfTaskDocumentRuntime, selfTaskDocumentMcpServers } from "../services/self-task-document-runtime.js";

describe("self task document runtime profile", () => {
  it("requires an explicit Claude opt-in and preserves the other isolated modes", () => {
    expect(isSelfTaskDocumentRuntime("claude_local", { selfTaskDocumentToolsOnly: true })).toBe(true);
    for (const config of [{}, { selfTaskDocumentToolsOnly: "true" },
      { selfTaskDocumentToolsOnly: true, qaReviewToolsOnly: true },
      { selfTaskDocumentToolsOnly: true, commanderCycleToolsOnly: true }]) {
      expect(isSelfTaskDocumentRuntime("claude_local", config)).toBe(false);
    }
    expect(isSelfTaskDocumentRuntime("codex_local", { selfTaskDocumentToolsOnly: true })).toBe(false);
    expect(isSelfTaskDocumentRuntime("paperclip_runner", { selfTaskDocumentToolsOnly: true })).toBe(false);
  });

  it("provides only the run-bound document endpoint, or none when a prerequisite is missing", () => {
    const input = { localApiUrl: "http://127.0.0.1:3317", authToken: "fixture-run-token", hasIssue: true };
    expect(selfTaskDocumentMcpServers(input)).toEqual([{ name: "Paperclip projects",
      url: "http://127.0.0.1:3317/api/mcp/project-tools", token: "fixture-run-token", connectionId: "paperclip-project-tools" }]);
    expect(selfTaskDocumentMcpServers({ ...input, localApiUrl: null })).toEqual([]);
    expect(selfTaskDocumentMcpServers({ ...input, authToken: undefined })).toEqual([]);
    expect(selfTaskDocumentMcpServers({ ...input, hasIssue: false })).toEqual([]);
  });

  it("retries only an executor-settled, exactly bound pre-provider setup failure", () => {
    const proof = { schema: "paperclip.self-task-document-pre-provider/v1", companyId: "company",
      agentId: "agent", runId: "run", wakeupRequestId: "wake", controllerBootId: "boot", issueId: "issue",
      cleanupSettledAt: "2026-10-29T00:00:00.000Z" };
    const run = { id: "run", companyId: "company", agentId: "agent", wakeupRequestId: "wake",
      controllerBootId: "boot", runtimeMode: "legacy", status: "failed", errorCode: "workspace_git_scan_timeout",
      processPid: null, processGroupId: null, processStartedAt: null, externalRunId: null, nativeSessionId: null,
      contextSnapshot: { [SELF_TASK_DOCUMENT_CONTEXT_KEY]: true, issueId: "issue" },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false, selfTaskDocumentPreProvider: proof } } };
    // This attestation is not permission for unrelated automatic replay lanes.
    expect(hasSelfTaskDocumentReplayHold(run)).toBe(true);
    const retryHold = hasSelfTaskDocumentSetupRetryHold;
    expect(retryHold(run)).toBe(false);
    // Old bare false histories and an attestation copied from a wake are not authority.
    expect(retryHold({ ...run,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })).toBe(true);
    expect(retryHold({ ...run, resultJson: {},
      contextSnapshot: { ...run.contextSnapshot, selfTaskDocumentPreProvider: proof } })).toBe(true);
    for (const patch of [{ status: "running" }, { runtimeMode: "native" }, { errorCode: "unknown" },
      { processPid: 123 }, { processGroupId: 123 }, { processStartedAt: new Date() },
      { externalRunId: "provider" }, { nativeSessionId: "native" }, { controllerBootId: "other" },
      { id: "other" }, { companyId: "other" }, { agentId: "other" }, { wakeupRequestId: "other" },
      { contextSnapshot: { ...run.contextSnapshot, issueId: "other" } },
      { contextSnapshot: { ...run.contextSnapshot, qaDecisionId: "decision" } },
      { resultJson: { executionRecovery: { ...run.resultJson.executionRecovery, providerWorkStarted: true } } },
      { resultJson: { executionRecovery: { ...run.resultJson.executionRecovery,
        selfTaskDocumentPreProvider: { ...proof, cleanupSettledAt: "" } } } }]) {
      expect(retryHold({ ...run, ...patch })).toBe(true);
    }
  });
});
