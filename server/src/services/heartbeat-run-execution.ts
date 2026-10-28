import type { NativeSessionStartupBusyError, NativeWarmSessionRetirementPendingError } from "./native-runtime/native-goal-delivery-hold.js";

export function canSettleNativeSessionStartupBusy(input: {
  scope: NativeSessionStartupBusyError["scope"];
  isRestartRecovery: boolean;
  ownedLease?: NativeWarmSessionRetirementPendingError["ownedLease"];
  coordinator: {
    phase: string;
    attempt: number;
    leaseOwner: string | null;
    resultId: string | null;
    controllerBootId?: string | null;
    controllerPid?: number | null;
    controllerProcessStartedAt?: Date | null;
    leaseExpiresAt?: Date | null;
  } | null;
}): boolean {
  const { coordinator } = input;
  if (input.ownedLease) {
    const owner = input.ownedLease;
    return !input.isRestartRecovery && input.scope !== "same_run" &&
      coordinator?.phase === "observed" && coordinator.resultId === null &&
      coordinator.leaseOwner === owner.owner && coordinator.attempt === owner.attempt &&
      coordinator.controllerBootId === owner.controllerBootId &&
      coordinator.controllerPid === owner.controllerPid &&
      coordinator.controllerProcessStartedAt?.getTime() === owner.controllerProcessStartedAt.getTime() &&
      Boolean(coordinator.leaseExpiresAt && coordinator.leaseExpiresAt > new Date());
  }
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
  try {
    if (error.scope === "same_run") return "deferred";
    // A failed ownership CAS can mean another controller acquired this same
    // Run after the busy rejection. It cannot authorize shared teardown.
    if (!(await actions.failCurrentRun())) return "deferred";
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
    // The reservation closure checks the exact in-process warm entry and its
    // preparing Run. It is this attempt's local preparation, even if the
    // durable Run is now owned by another executor.
    await actions.releaseCurrentReservation();
  }
}

/** Release a rejected Run's new sandbox while retaining a proven or unknown
 * shared reusable lease. Acquisition outcomes are written by the environment
 * runtime; policy alone does not prove that a provider was reused. */
export async function releaseRejectedNativeStartupRunLeases(actions: {
  listCurrentRunLeases: () => Promise<Array<{ leasePolicy: string; acquisitionOutcome?: string | null }>>;
  retainReusableLeases: () => Promise<void>;
  releaseNonReusableLeases: () => Promise<void>;
}): Promise<"released" | "shared_lease_unresolved"> {
  const current = await actions.listCurrentRunLeases();
  const sharedReusable = current.filter(lease => lease.leasePolicy === "reuse_by_environment" &&
    !["created", "replacement"].includes(lease.acquisitionOutcome ?? ""));
  const freshReusable = current.filter(lease => lease.leasePolicy === "reuse_by_environment" &&
    ["created", "replacement"].includes(lease.acquisitionOutcome ?? ""));
  // The run-level release API cannot split a mixed shared/fresh reusable set.
  // Leave it observable instead of stopping the shared provider or retaining
  // a newly created sandbox under a false release receipt.
  if (sharedReusable.length > 0 && freshReusable.length > 0) return "shared_lease_unresolved";
  if (sharedReusable.length > 0) {
    await actions.retainReusableLeases();
  }
  const remaining = await actions.listCurrentRunLeases();
  if (sharedReusable.length > 0 && remaining.some(lease => lease.leasePolicy === "reuse_by_environment")) {
    return "shared_lease_unresolved";
  }
  if (remaining.length > 0) await actions.releaseNonReusableLeases();
  return "released";
}
