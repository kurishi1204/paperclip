import { describe, expect, it } from "vitest";
import type { AcpPermissionRequest } from "acpx/runtime";
import { normalizeAcpxPermission } from "./acp-permission-adapter.js";

function request(kinds = ["allow_once", "allow_always", "reject_once"]): AcpPermissionRequest {
  return { sessionId: "session", inferredKind: "edit", raw: {
    sessionId: "session", toolCall: { toolCallId: "call", title: "Edit source" },
    options: kinds.map((kind, i) => ({ kind, optionId: `option-${i}`, name: kind })),
  } } as AcpPermissionRequest;
}
describe("ACP permission normalization", () => {
  it("shows operation arguments before a permission decision without exposing credentials", () => {
    const value = request();
    Object.assign(value.raw.toolCall, { title: "mcp__paperclip__call_api", rawInput: {
      operationId: "GET /api/issues/{id}/documents/{key}",
      pathParams: { id: "parent-task", key: "knowledge-verification-readiness" },
      query: { token: "fixture-secret-value" }, responseText: { limitBytes: 24576 },
    } });
    const result = normalizeAcpxPermission(value);
    expect(result.title).toContain("GET /api/issues/{id}/documents/{key}");
    expect(result.title).toContain("knowledge-verification-readiness");
    expect(result.title).toContain("24576");
    expect(result.title).toContain("[REDACTED]");
    expect(result.title).not.toContain("fixture-secret-value");
    expect(result.resolve({ action: "accept" })).toEqual({ outcome: "allow_once" });
  });

  it("makes omitted oversized permission arguments visible instead of silently dropping them", () => {
    const value = request(); Object.assign(value.raw.toolCall, { rawInput: { body: "x".repeat(10000) } });
    const result = normalizeAcpxPermission(value);
    expect(result.title).toContain("Arguments omitted");
    expect(result.title.length).toBeLessThanOrEqual(4000);
    expect(result.choices.map(x => x.key)).toEqual(["accept", "decline", "cancel"]);
  });
  it("keeps requests answerable when a provider omits its operation title", () => {
    for (const title of [undefined, "", "   "]) {
      const value = request();
      value.raw.toolCall.title = title;
      expect(normalizeAcpxPermission(value).title).toBe("Approve provider operation");
    }
  });
  it("offers only native choices and preserves cancellation", () => {
    const value = normalizeAcpxPermission(request(["allow_once"]));
    expect(value.choices.map(c => c.key)).toEqual(["accept", "cancel"]);
    expect(value.resolve({ action: "accept" })).toEqual({ outcome: "allow_once" });
    expect(value.resolve({ action: "cancel" })).toEqual({ outcome: "cancel" });
    expect(() => value.resolve({ action: "accept_for_session" })).toThrow("offered choice");
    expect(() => value.resolve({ action: "submit", content: { accept: true } })).toThrow("offered choice");
  });
  it("maps once, session and denial distinctly", () => {
    const value = normalizeAcpxPermission(request(), { allowAlwaysScope: "session" });
    expect(value.resolve({ action: "accept_for_session" })).toEqual({ outcome: "allow_always" });
    expect(value.resolve({ action: "decline" })).toEqual({ outcome: "reject_once" });
  });
  it("does not label an unverified persistent allowance as session-only", () => {
    const value = normalizeAcpxPermission(request());
    expect(value.choices.map(choice => choice.key)).toEqual(["accept", "decline", "cancel"]);
    expect(() => value.resolve({ action: "accept_for_session" })).toThrow("offered choice");
  });
  it("does not turn a one-time denial into permanent rejection", () => {
    expect(normalizeAcpxPermission(request(["reject_always"])).choices).toEqual([{ key: "cancel", label: "Cancel" }]);
  });
  it("rejects ambiguous provider choices before any resolution", () => {
    expect(() => normalizeAcpxPermission(request(["allow_once", "allow_once"]))).toThrow("ambiguous");
    const duplicate = request(); duplicate.raw.options[1]!.optionId = duplicate.raw.options[0]!.optionId;
    expect(() => normalizeAcpxPermission(duplicate)).toThrow("ambiguous");
  });
});
