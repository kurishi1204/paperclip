import { describe, expect, it } from "vitest";
import { isSelfTaskDocumentRuntime, selfTaskDocumentMcpServers } from "../services/self-task-document-runtime.js";

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
});
