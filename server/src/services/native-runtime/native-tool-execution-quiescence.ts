/** Execution evidence only: never a semantic result or external-effect receipt. */
export interface NativeToolExecutionEpochBinding {
  readonly companyId: string;
  readonly agentId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly epochId: string;
  readonly normalizedSessionId: string;
  readonly runnerInstanceId: string;
  readonly environmentLeaseId: string;
}

export interface NativeToolExecutionCallIdentity {
  readonly callId: string;
  readonly operationId: string;
  readonly sourceEventId: string;
  readonly sourceEventType: string;
  readonly inputDigest: string;
  readonly correlation: {
    readonly runId: string;
    readonly normalizedSessionId: string;
    readonly turnId: string;
    readonly itemId: string;
  };
}

export interface NativeToolExecutionStart {
  readonly callId: string;
  readonly operationId: string;
  /** Supplied by the authenticated original input, never reconstructed from a trace. */
  readonly nativeToolExecution?: NativeToolExecutionCallIdentity;
}

declare const stopReceiptBrand: unique symbol;
export interface NativeToolExecutionStopReceipt {
  readonly [stopReceiptBrand]: true;
  readonly schema: "paperclip.native-tool-execution-stop.v1";
  readonly scope: "awaited_handler_promises";
  readonly binding: Readonly<NativeToolExecutionEpochBinding>;
  readonly calls: readonly NativeToolExecutionCallIdentity[];
  readonly businessOutcome: "unverified";
}

const issued = new WeakMap<object, NativeToolExecutionQuiescence>();
const bindingKeys = ["companyId", "agentId", "issueId", "runId", "epochId", "normalizedSessionId", "runnerInstanceId", "environmentLeaseId"] as const;
const callKeys = ["callId", "operationId", "sourceEventId", "sourceEventType", "inputDigest"] as const;
const correlationKeys = ["runId", "normalizedSessionId", "turnId", "itemId"] as const;
function present(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2000 && value.trim() === value;
}
function sameCall(a: NativeToolExecutionCallIdentity, b: NativeToolExecutionCallIdentity): boolean {
  return callKeys.every(key => a[key] === b[key])
    && correlationKeys.every(key => a.correlation[key] === b.correlation[key]);
}
function copyIdentity(value: NativeToolExecutionCallIdentity | undefined): NativeToolExecutionCallIdentity | null {
  if (!value || !callKeys.every(key => present(value[key])) || !/^[0-9a-f]{64}$/.test(value.inputDigest)
    || !value.correlation || !correlationKeys.every(key => present(value.correlation[key]))) return null;
  return Object.freeze({ ...Object.fromEntries(callKeys.map(key => [key, value[key]])),
    correlation: Object.freeze({ ...Object.fromEntries(correlationKeys.map(key => [key, value.correlation[key]])) }),
  }) as unknown as NativeToolExecutionCallIdentity;
}

interface TrackedExecution {
  readonly identity: NativeToolExecutionCallIdentity | null;
  readonly finished: Promise<void>;
}

/** One live authority epoch. Every handler must enter through track from inception. */
export class NativeToolExecutionQuiescence {
  readonly #binding: Readonly<NativeToolExecutionEpochBinding>;
  #fenced = false;
  #invalidated = false;
  #calls = new Map<string, TrackedExecution>();
  #receipt: NativeToolExecutionStopReceipt | null = null;

  constructor(binding: NativeToolExecutionEpochBinding) {
    if (!bindingKeys.every(key => present(binding[key]))) throw new Error("native_tool_execution_epoch_identity_missing");
    this.#binding = Object.freeze(Object.fromEntries(bindingKeys.map(key => [key, binding[key]]))) as unknown as NativeToolExecutionEpochBinding;
  }

  get binding(): Readonly<NativeToolExecutionEpochBinding> { return this.#binding; }

  track<T>(call: NativeToolExecutionStart, handler: () => T | PromiseLike<T>): Promise<T> {
    if (this.#fenced || this.#invalidated) throw new Error("native_tool_authority_epoch_revoked");
    if (!present(call.callId) || !present(call.operationId)) throw new Error("native_tool_execution_call_identity_missing");
    if (this.#calls.has(call.callId)) throw new Error("native_tool_execution_duplicate_call");
    let identity = copyIdentity(call.nativeToolExecution);
    if (identity && (identity.callId !== call.callId || identity.operationId !== call.operationId
      || identity.correlation.runId !== this.#binding.runId
      || identity.correlation.normalizedSessionId !== this.#binding.normalizedSessionId)) identity = null;

    // Reserve the call before invoking user code, including synchronous throws
    // or re-entrant revoke(). Missing instrumentation does not stop normal work;
    // it prevents this epoch from issuing a stop proof later.
    let resolveFinished!: () => void;
    const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
    this.#calls.set(call.callId, { identity, finished });
    let execution: Promise<T>;
    try { execution = Promise.resolve(handler()); }
    catch (error) { execution = Promise.reject(error); }
    const finalized = execution.finally(() => undefined);
    // This continuation runs only after the handler and its finally chain have
    // actually settled. Do not replace it with AbortSignal or a timeout race.
    void finalized.then(resolveFinished, resolveFinished);
    return finalized;
  }

  revoke(): void { this.#fenced = true; }

  /** Invalidate after the original epoch's owner/lease is retired or replaced. */
  invalidate(): void { this.#invalidated = true; this.#fenced = true; }

  async awaitStopped(): Promise<NativeToolExecutionStopReceipt> {
    this.#assertIssuable();
    await Promise.all([...this.#calls.values()].map(call => call.finished));
    this.#assertIssuable();
    if (!this.#receipt) {
      const receipt = Object.freeze({
        schema: "paperclip.native-tool-execution-stop.v1", scope: "awaited_handler_promises",
        binding: this.#binding, calls: Object.freeze([...this.#calls.values()].map(call => call.identity!)),
        businessOutcome: "unverified",
      }) as NativeToolExecutionStopReceipt;
      issued.set(receipt, this);
      this.#receipt = receipt;
    }
    return this.#receipt;
  }

  /** No receipt exists until awaitStopped has observed actual finalization. */
  getStoppedReceipt(): NativeToolExecutionStopReceipt {
    if (!this.#receipt) throw new Error("native_tool_execution_stop_not_observed");
    this.assertReceiptCurrent(this.#receipt);
    return this.#receipt;
  }

  assertReceiptCurrent(receipt: NativeToolExecutionStopReceipt): void {
    if (!receipt || issued.get(receipt) !== this || receipt !== this.#receipt || !this.#fenced || this.#invalidated) {
      throw new Error("native_tool_execution_stop_receipt_unverified");
    }
  }

  assertCallsStopped(receipt: NativeToolExecutionStopReceipt, calls: readonly NativeToolExecutionCallIdentity[]): void {
    this.assertReceiptCurrent(receipt);
    if (calls.length === 0) throw new Error("native_tool_execution_call_coverage_missing");
    const unique = new Set<string>();
    for (const requested of calls) {
      const expected = copyIdentity(requested);
      if (!expected || unique.has(expected.callId)) throw new Error("native_tool_execution_call_coverage_invalid");
      unique.add(expected.callId);
      const tracked = this.#calls.get(expected.callId)?.identity;
      if (!tracked || !sameCall(tracked, expected)) throw new Error("native_tool_execution_call_not_proven_stopped");
    }
  }

  #assertIssuable(): void {
    if (!this.#fenced || this.#invalidated) throw new Error("native_tool_execution_epoch_not_fenced");
    if (this.#calls.size === 0 || [...this.#calls.values()].some(call => call.identity === null)) {
      throw new Error("native_tool_execution_uninstrumented_calls");
    }
  }
}

/** Process-local capability; JSON copies cannot be turned into a trusted receipt. */
export function createNativeToolExecutionStopAssertion(receipt: NativeToolExecutionStopReceipt) {
  const owner = receipt && issued.get(receipt);
  if (!owner) throw new Error("native_tool_execution_stop_receipt_unverified");
  owner.assertReceiptCurrent(receipt);
  return Object.freeze({
    assertCurrent: () => owner.assertReceiptCurrent(receipt),
    assertCallsStopped: (calls: readonly NativeToolExecutionCallIdentity[]) => owner.assertCallsStopped(receipt, calls),
  });
}
