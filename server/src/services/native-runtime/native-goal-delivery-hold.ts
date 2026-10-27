import type { RunnerGoalDeliveryClaim } from "../runner-goals.js";
import { GOAL_DELIVERY_INDETERMINATE_CODE } from "../runner-goal-delivery-policy.js";

/** The executor may settle only the attempt whose native lease it owns. */
export class NativeGoalDeliveryHeldError extends Error {
  readonly code = GOAL_DELIVERY_INDETERMINATE_CODE;

  constructor(
    readonly settled: boolean,
    readonly claimState: RunnerGoalDeliveryClaim["state"] | "ready" | "claim_unavailable",
    readonly receiptRelation: RunnerGoalDeliveryClaim["receiptRelation"] | "no_claim",
  ) {
    super(GOAL_DELIVERY_INDETERMINATE_CODE);
    this.name = "NativeGoalDeliveryHeldError";
  }
}

/** Raised before the caller has claimed a durable native execution lease. */
export class NativeSessionStartupBusyError extends Error {
  readonly code = "native_session_supervisor_busy";

  constructor(readonly scope: "same_run" | "owner_scope" | "session_scope") {
    super("native_session_supervisor_busy");
    this.name = "NativeSessionStartupBusyError";
  }
}

/** The coordinator claim never returned an owned lease for this caller. */
export class NativeSessionLeaseNotOwnedError extends Error {
  readonly code = "native_session_lease_not_owned";

  constructor(readonly reason: string | null = null) {
    super("native_session_lease_not_owned");
    this.name = "NativeSessionLeaseNotOwnedError";
  }
}
