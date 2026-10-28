import { describe, expect, it } from "vitest";
import { classifySessionGoalRecoveryAction } from "./session-goal-recovery-policy.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const stored = {
  requestId: "goal-control-1",
  agentId,
  expectedRevision: 7,
  action: "replace",
  objective: "Finish the selected task",
  confirmReplace: true,
};

describe("startup session goal recovery", () => {
  it("holds every legacy open status without interpreting payload as unsent", () => {
    for (const status of ["pending", "delivering", "delivered"]) {
      expect(classifySessionGoalRecoveryAction({
        status, payload: stored, requestId: stored.requestId, agentId,
      })).toBe("held");
    }
  });

  it("queues a complete ready request and rejects a truncated control", () => {
    expect(classifySessionGoalRecoveryAction({
      status: "ready", payload: stored, requestId: stored.requestId, agentId,
    })).toBe("ready");
    expect(classifySessionGoalRecoveryAction({
      status: "ready", payload: { requestId: stored.requestId, action: "replace", objective: stored.objective },
      requestId: stored.requestId, agentId,
    })).toBe("invalid");
    expect(classifySessionGoalRecoveryAction({
      status: "ready", payload: { ...stored, unrecognized: true },
      requestId: stored.requestId, agentId,
    })).toBe("invalid");
  });

  it("refuses an action bound to another request or agent", () => {
    expect(classifySessionGoalRecoveryAction({
      status: "ready", payload: stored, requestId: "other", agentId,
    })).toBe("invalid");
    expect(classifySessionGoalRecoveryAction({
      status: "ready", payload: stored, requestId: stored.requestId,
      agentId: "22222222-2222-4222-8222-222222222222",
    })).toBe("invalid");
  });
});
