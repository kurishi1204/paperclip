/** Only actions created with the explicit ready marker can be sent for the first time. */
export type GoalDeliveryDecision = "claim" | "completed" | "failed" | "indeterminate";
export const GOAL_DELIVERY_INDETERMINATE_CODE = "session_goal_control_delivery_indeterminate" as const;

export class GoalDeliveryIndeterminateError extends Error {
  readonly code = GOAL_DELIVERY_INDETERMINATE_CODE;

  constructor(message: string) {
    super(message);
    this.name = "GoalDeliveryIndeterminateError";
  }
}

export function decideGoalDelivery(status: string): GoalDeliveryDecision {
  if (status === "ready") return "claim";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  // Legacy pending has no reliable proof of non-delivery. Delivering and
  // delivered can also represent a command with an unknown provider outcome.
  return "indeterminate";
}
