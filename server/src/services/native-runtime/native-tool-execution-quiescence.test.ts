import { describe, expect, it } from "vitest";
import { NativeToolExecutionQuiescence, createNativeToolExecutionStopAssertion,
  type NativeToolExecutionCallIdentity } from "./native-tool-execution-quiescence.js";

const binding = { companyId: "company", agentId: "colo", issueId: "issue", runId: "run",
  epochId: "epoch-1", normalizedSessionId: "session", runnerInstanceId: "runner", environmentLeaseId: "lease" };
const call: NativeToolExecutionCallIdentity = { callId: "call-1", operationId: "read_document", sourceEventId: "event-1",
  sourceEventType: "tool.call", inputDigest: "a".repeat(64),
  correlation: { runId: binding.runId, normalizedSessionId: binding.normalizedSessionId, turnId: "turn", itemId: "item" } };
const start = (identity = call) => ({ callId: identity.callId, operationId: identity.operationId, nativeToolExecution: identity });

describe("native tool execution quiescence", () => {
  it("withholds proof until the original handler's asynchronous finally ends, then keeps new starts fenced", async () => {
    const monitor = new NativeToolExecutionQuiescence(binding);
    let releaseBody!: () => void, releaseFinally!: () => void;
    const body = new Promise<void>(resolve => { releaseBody = resolve; });
    const cleanup = new Promise<void>(resolve => { releaseFinally = resolve; });
    const semanticPending = { outcome: "UNKNOWN", pending: [call.callId] };
    const execution = monitor.track(start(), async () => {
      try { await body; return "handler value"; }
      finally { await cleanup; }
    });
    monitor.revoke();
    let receiptPublished = false;
    const stopping = monitor.awaitStopped().then(receipt => { receiptPublished = true; return receipt; });
    await Promise.resolve();
    expect(() => monitor.getStoppedReceipt()).toThrow("stop_not_observed");
    releaseBody(); await Promise.resolve(); await Promise.resolve();
    expect(receiptPublished).toBe(false);
    expect(() => monitor.getStoppedReceipt()).toThrow("stop_not_observed");
    releaseFinally();
    expect(await execution).toBe("handler value");
    const receipt = await stopping;
    expect(receipt.businessOutcome).toBe("unverified");
    const assertion = createNativeToolExecutionStopAssertion(receipt);
    assertion.assertCurrent(); assertion.assertCallsStopped([call]);
    expect(semanticPending).toEqual({ outcome: "UNKNOWN", pending: [call.callId] });
    expect(() => monitor.track(start({ ...call, callId: "new-call" }), () => "unexpected")).toThrow("epoch_revoked");
    expect(monitor.getStoppedReceipt()).toBe(receipt);
  });

  it("does not treat an abort notification or a caller timeout race as handler completion", async () => {
    const monitor = new NativeToolExecutionQuiescence(binding);
    const abort = new AbortController(); let release!: () => void;
    const running = monitor.track(start(), () => new Promise<void>(resolve => { release = resolve; }));
    monitor.revoke(); abort.abort();
    const stopping = monitor.awaitStopped();
    expect(await Promise.race([stopping.then(() => "receipt"), Promise.resolve("caller-timeout")])).toBe("caller-timeout");
    expect(abort.signal.aborted).toBe(true);
    expect(() => monitor.getStoppedReceipt()).toThrow("stop_not_observed");
    release(); await running; await stopping;
  });

  it("preserves a rejected business result while proving only execution finalization", async () => {
    const monitor = new NativeToolExecutionQuiescence(binding);
    const error = new Error("business outcome remains unknown");
    const running = monitor.track(start(), () => { throw error; });
    await expect(running).rejects.toBe(error);
    monitor.revoke();
    const receipt = await monitor.awaitStopped();
    createNativeToolExecutionStopAssertion(receipt).assertCallsStopped([call]);
    expect(receipt.businessOutcome).toBe("unverified");
  });

  it("refuses retroactive, empty or incomplete instrumentation without blocking the ordinary handler", async () => {
    const empty = new NativeToolExecutionQuiescence(binding); empty.revoke();
    await expect(empty.awaitStopped()).rejects.toThrow("uninstrumented_calls");
    const missing = new NativeToolExecutionQuiescence(binding);
    expect(await missing.track({ callId: call.callId, operationId: call.operationId }, () => "ordinary work continues")).toBe("ordinary work continues");
    missing.revoke();
    await expect(missing.awaitStopped()).rejects.toThrow("uninstrumented_calls");
    const wrong = new NativeToolExecutionQuiescence(binding);
    expect(await wrong.track(start({ ...call, correlation: { ...call.correlation, runId: "other" } }), () => "unchanged work")).toBe("unchanged work");
    wrong.revoke(); await expect(wrong.awaitStopped()).rejects.toThrow("uninstrumented_calls");
  });

  it("binds every assertion to its exact call, original input and live issuer object", async () => {
    const monitor = new NativeToolExecutionQuiescence(binding);
    await monitor.track(start(), () => undefined); monitor.revoke();
    const receipt = await monitor.awaitStopped(), assertion = createNativeToolExecutionStopAssertion(receipt);
    expect(() => Object.assign(monitor, { binding: { ...binding, runId: "replacement-run" } })).toThrow();
    expect(receipt.binding).toEqual(binding);
    for (const changed of [{ ...call, callId: "other" }, { ...call, inputDigest: "b".repeat(64) },
      { ...call, sourceEventId: "other-event" }, { ...call, correlation: { ...call.correlation, turnId: "other-turn" } }]) {
      expect(() => assertion.assertCallsStopped([changed])).toThrow("not_proven_stopped");
    }
    expect(() => assertion.assertCallsStopped([])).toThrow("coverage_missing");
    expect(() => createNativeToolExecutionStopAssertion(JSON.parse(JSON.stringify(receipt)))).toThrow("receipt_unverified");
    const other = new NativeToolExecutionQuiescence({ ...binding, epochId: "epoch-2" });
    expect(() => other.assertReceiptCurrent(receipt)).toThrow("receipt_unverified");
    monitor.invalidate();
    expect(() => assertion.assertCurrent()).toThrow("receipt_unverified");
    expect(() => assertion.assertCallsStopped([call])).toThrow("receipt_unverified");
  });

  it("rejects an unfenced receipt or duplicate call instead of replacing evidence", async () => {
    const monitor = new NativeToolExecutionQuiescence(binding);
    await monitor.track(start(), () => undefined);
    await expect(monitor.awaitStopped()).rejects.toThrow("epoch_not_fenced");
    expect(() => monitor.track(start(), () => undefined)).toThrow("duplicate_call");
    monitor.revoke(); createNativeToolExecutionStopAssertion(await monitor.awaitStopped()).assertCallsStopped([call]);
  });
});
