import type { NativeSessionStartupBusyError } from "./native-runtime/native-goal-delivery-hold.js";

export function canSettleNativeSessionStartupBusy(input: {
  scope: NativeSessionStartupBusyError["scope"];
  isRestartRecovery: boolean;
  coordinator: {
    phase: string;
    attempt: number;
    leaseOwner: string | null;
    resultId: string | null;
  } | null;
}): boolean {
  const { coordinator } = input;
  return input.scope !== "same_run" && !input.isRestartRecovery &&
    coordinator?.phase === "observed" && coordinator.attempt === 0 &&
    coordinator.leaseOwner === null && coordinator.resultId === null;
}

/** Own the in-process run entry before any asynchronous admission or setup. */
export async function withHeartbeatRunExecution(
  activeRuns: Set<string>,
  runId: string,
  execute: () => Promise<void>,
): Promise<void> {
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  try {
    await execute();
  } finally {
    activeRuns.delete(runId);
  }
}

/** A different run lost a pre-effect session claim. Settle only that run. */
export async function settleNativeSessionStartupBusy(
  error: NativeSessionStartupBusyError,
  actions: {
    failCurrentRun: () => Promise<boolean>;
    failCurrentWakeup: () => Promise<void>;
    releaseCurrentIssue: () => Promise<void>;
    finalizeAgent: () => Promise<void>;
    releaseCurrentReservation: () => Promise<void>;
  },
): Promise<"deferred" | "settled"> {
  if (error.scope === "same_run") return "deferred";
  // A failed ownership CAS can mean another controller acquired this same
  // Run after the busy rejection. It cannot authorize local/shared teardown.
  if (!(await actions.failCurrentRun())) return "deferred";
  try {
    let firstError: unknown;
    let failed = false;
    for (const action of [actions.failCurrentWakeup, actions.releaseCurrentIssue, actions.finalizeAgent]) {
      try {
        await action();
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
    if (failed) throw firstError;
    return "settled";
  } finally {
    await actions.releaseCurrentReservation();
  }
}

/** Release the rejected Run's leases without stopping a shared reusable owner. */
export async function releaseRejectedNativeStartupRunLeases(actions: {
  listCurrentRunLeases: () => Promise<Array<{ leasePolicy: string }>>;
  retainReusableLeases: () => Promise<void>;
  releaseNonReusableLeases: () => Promise<void>;
}): Promise<"released" | "shared_lease_unresolved"> {
  const current = await actions.listCurrentRunLeases();
  if (current.some(lease => lease.leasePolicy === "reuse_by_environment")) {
    await actions.retainReusableLeases();
  }
  const remaining = await actions.listCurrentRunLeases();
  if (remaining.some(lease => lease.leasePolicy === "reuse_by_environment")) {
    return "shared_lease_unresolved";
  }
  if (remaining.length > 0) await actions.releaseNonReusableLeases();
  return "released";
}
