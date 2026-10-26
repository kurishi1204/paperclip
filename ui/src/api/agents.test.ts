import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "./agents";
import { api, ApiError } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("agentsApi.retryFailedRun", () => {
  it("surfaces a server 409 denial with its message and does not dispatch again", async () => {
    const denial = new ApiError("The original run cannot be retried.", 409, { error: "The original run cannot be retried." });
    const post = vi.spyOn(api, "post").mockRejectedValue(denial);
    await expect(agentsApi.retryFailedRun("agent-1", "original-failure", "company-1"))
      .rejects.toBe(denial);
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith("/agents/agent-1/wakeup?companyId=company-1", {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
      failedRunId: "original-failure",
    });
  });

  it.each(["failed", "timed_out", "cancelled", "interrupted"])(
    "reports a replayed %s retry instead of silently succeeding",
    async (status) => {
      const post = vi.spyOn(api, "post").mockResolvedValue({ id: "previous-retry", status });
      await expect(agentsApi.retryFailedRun("agent-1", "original-failure", "company-1"))
        .rejects.toThrow("The previous retry has already stopped");
      expect(post).toHaveBeenCalledOnce();
    },
  );

  it.each(["queued", "running", "succeeded"])("accepts a %s successor without dispatching again", async (status) => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ id: "successor", status });
    await expect(agentsApi.retryFailedRun("agent-1", "original-failure", "company-1"))
      .resolves.toEqual({ runId: "successor", issueId: null });
    expect(post).toHaveBeenCalledOnce();
  });

  it("preserves a durable chat retry that is waiting for dispatch", async () => {
    vi.spyOn(api, "post").mockResolvedValue({ actionId: "retry-action", status: "queued", runId: null, issueId: "issue-1" });
    await expect(agentsApi.retryFailedRun("agent-1", "original-failure", "company-1"))
      .resolves.toEqual({ runId: null, issueId: "issue-1" });
  });

  it("reports a skipped wake", async () => {
    vi.spyOn(api, "post").mockResolvedValue({ skipped: true, message: "Task execution is paused." });
    await expect(agentsApi.retryFailedRun("agent-1", "original-failure", "company-1"))
      .rejects.toThrow("Task execution is paused.");
  });
});
