import type { RunnerGoalDeliveryClaim } from "../runner-goals.js";
import { GOAL_DELIVERY_INDETERMINATE_CODE } from "../runner-goal-delivery-policy.js";

/** Durable Run settlement and physical provider retirement are independent facts.
 * A settled HOLD may still own an unretired warm provider/environment. */
export class NativeGoalDeliveryHeldError extends Error {
  readonly code = GOAL_DELIVERY_INDETERMINATE_CODE;

  constructor(
    readonly settled: boolean,
    readonly claimState: RunnerGoalDeliveryClaim["state"] | "ready" | "claim_unavailable",
    readonly receiptRelation: RunnerGoalDeliveryClaim["receiptRelation"] | "no_claim",
    readonly resourceRetirementDeferred = false,
  ) {
    super(GOAL_DELIVERY_INDETERMINATE_CODE);
    this.name = "NativeGoalDeliveryHeldError";
  }
}

/** Raised before the caller has claimed a durable native execution lease. */
export class NativeSessionStartupBusyError extends Error {
  readonly code: string = "native_session_supervisor_busy";

  constructor(readonly scope: "same_run" | "owner_scope" | "session_scope") {
    super("native_session_supervisor_busy");
    this.name = "NativeSessionStartupBusyError";
  }
}

/** A fresh attempt acquired its own lease but could not retire a prior warm
 * transport. The exact lease identity is required before settling that new Run. */
export class NativeWarmSessionRetirementPendingError extends NativeSessionStartupBusyError {
  override readonly code = "native_warm_session_retirement_pending";

  constructor(readonly ownedLease: {
    owner: string;
    attempt: number;
    controllerBootId: string;
    controllerPid: number;
    controllerProcessStartedAt: Date;
  } | null, cause: unknown) {
    super("owner_scope");
    this.name = "NativeWarmSessionRetirementPendingError";
    this.message = this.code;
    Object.defineProperty(this, "cause", { value: cause, configurable: true });
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
