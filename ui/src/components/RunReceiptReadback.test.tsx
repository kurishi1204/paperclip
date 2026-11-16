// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeRunReceiptReadback } from "../api/heartbeat-receipts";
import { ApiError } from "../api/client";
import { RunReceiptReadback, RunReceiptReadbackView } from "./RunReceiptReadback";

const read = vi.hoisted(() => vi.fn());
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { receiptReadback: read } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const run = { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "failed" as const };
let root: Root | undefined;
let container: HTMLDivElement | undefined;
function fixture(): NativeRunReceiptReadback {
  return {
    schema: "paperclip.native-run-receipt-readback.v1", observedAtUTC: "2026-11-16T12:00:00Z",
    scope: { companyId: run.companyId, issueId: "task-1", runId: run.id, agentId: run.agentId },
    comparison: { state: "unverified", expectedCanonicalSha256: null, reasons: [], complete: true },
    results: { complete: true, limit: 20, rows: [{ id: "saved-result", schemaStatus: "accepted", canonicalSha256: "a".repeat(64), completionContractId: "contract", turnIdHash: null, serverFingerprint: null, callerResultIdHash: null, callerDedupeKeyHash: null, createdAt: "2026-11-16T11:59:00Z" }] },
    finalization: { state: "missing", record: null }, decision: { state: "missing", record: null },
    effects: { state: "unverified", complete: true, limit: 50, rows: [] },
    authority: { run: { status: "failed", runtimeMode: "native", runnerInstanceId: null, nativeSessionId: null, controllerBootId: null, controllerLeaseExpiresAt: null, processPid: null, processStartedAt: null }, issue: null, environmentLeases: { complete: true, limit: 20, rows: [] } },
  };
}
async function render(element: React.ReactNode) {
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(element); });
  return container;
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; container?.remove(); container = undefined; vi.clearAllMocks();
});

describe("Run receipt readback", () => {
  it("keeps a saved accepted result visible beside a failed company Run without business acceptance", async () => {
    const receipt = { ...fixture(), resultJson: "PRIVATE-BODY-MUST-NOT-RENDER" };
    const el = await render(<RunReceiptReadbackView run={run} receipt={receipt} />);
    expect(el.textContent).toContain("結果の受領記録が保存されています");
    expect(el.textContent).toContain("失敗として記録");
    expect(el.textContent).toContain("返却処理の配達記録は未確認");
    expect(el.textContent).toContain("対象版との一致は未確認");
    expect(el.textContent).not.toContain("PRIVATE-BODY-MUST-NOT-RENDER");
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });
  it("does not convert owner denial or store failure into missing results", async () => {
    const el = await render(<RunReceiptReadbackView run={run} error={new ApiError("raw-sensitive-error", 403, {})} />);
    expect(el.textContent).toContain("会社所有者だけが確認できます");
    expect(el.textContent).not.toContain("見つかりません");
    expect(el.textContent).not.toContain("raw-sensitive-error");
    await act(async () => root!.render(<RunReceiptReadbackView run={run} error={new Error("private-store-path")} />));
    expect(el.textContent).toContain("最新の受領記録を取得できません");
    expect(el.textContent).not.toContain("private-store-path");
  });
  it("rejects metadata from another Run and handles an older API response", async () => {
    const receipt = fixture(); receipt.scope.runId = "another-run";
    const el = await render(<RunReceiptReadbackView run={run} receipt={receipt} />);
    expect(el.textContent).toContain("対象Runと一致する受領記録を確認できません");
    expect(el.textContent).not.toContain("saved-result");
    await act(async () => root!.render(<RunReceiptReadbackView run={run} />));
    expect(el.textContent).toContain("この応答には受領記録が含まれていません");
  });
  it("retains every returned row and marks capped lists incomplete", async () => {
    const receipt = fixture(); receipt.results.complete = false; receipt.comparison.complete = false;
    receipt.effects.complete = false; receipt.authority.environmentLeases.complete = false;
    receipt.results.rows.push({ ...receipt.results.rows[0], id: "second-result" });
    const el = await render(<RunReceiptReadbackView run={run} receipt={receipt} />);
    expect(el.textContent).toContain("結果全体は未確認");
    expect(el.textContent).toContain("返却処理の一覧は全体未確認");
    expect(el.textContent).toContain("保持資源の記録は全体未確認");
    expect(el.textContent).toContain("saved-result"); expect(el.textContent).toContain("second-result");
  });
  it("does not claim consumer acknowledgement even when recorded effects are delivered", async () => {
    const receipt = fixture(); receipt.effects.state = "found";
    receipt.effects.rows = [{ id: "effect-1", decisionId: "decision-1", ordinal: 0, effectKind: "publish_comment", targetType: "task", targetIdHash: null, idempotencyKeyHash: "b".repeat(64), deliveryState: "delivered", attemptCount: 1, nextAttemptAt: null, deliveredAt: "2026-11-16T12:00:00Z", updatedAt: "2026-11-16T12:00:00Z" }];
    const el = await render(<RunReceiptReadbackView run={run} receipt={receipt} />);
    expect(el.textContent).toContain("相手の実読・採否は別に確認が必要");
  });
  it("uses the opt-in read client and makes no mutation or retry", async () => {
    read.mockResolvedValue({ receiptReadback: fixture() });
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
    const el = await render(<QueryClientProvider client={client}><RunReceiptReadback run={run} /></QueryClientProvider>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(run.id, { signal: expect.any(AbortSignal) });
    expect(el.textContent).toContain("結果の受領記録が保存されています");
    client.clear();
  });
});
