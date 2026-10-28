import { isDeepStrictEqual } from "node:util";
import { runnerGoalActionRequestSchema } from "@paperclipai/shared";

/** Startup may queue only an action with the new, explicit unsent marker. */
export function classifySessionGoalRecoveryAction(input: {
  status: string;
  payload: unknown;
  requestId: string;
  agentId: string;
}): "ready" | "held" | "invalid" {
  if (input.status !== "ready") return "held";
  const request = runnerGoalActionRequestSchema.safeParse(input.payload);
  if (!request.success || !isDeepStrictEqual(request.data, input.payload) ||
      request.data.requestId !== input.requestId ||
      request.data.agentId !== input.agentId) return "invalid";
  return "ready";
}
