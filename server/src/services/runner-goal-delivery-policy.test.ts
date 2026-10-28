import { describe, expect, it } from "vitest";
import { decideGoalDelivery } from "./runner-goal-delivery-policy.js";

describe("goal delivery policy", () => {
  it("permits only the explicit new ready marker", () => {
    expect(decideGoalDelivery("ready")).toBe("claim");
    for (const status of ["pending", "delivering", "delivered", "unknown", ""]) {
      expect(decideGoalDelivery(status)).toBe("indeterminate");
    }
    expect(decideGoalDelivery("completed")).toBe("completed");
    expect(decideGoalDelivery("failed")).toBe("failed");
  });
});
