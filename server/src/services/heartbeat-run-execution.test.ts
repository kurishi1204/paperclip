import { describe, expect, it, vi } from "vitest";
import { canSettleNativeSessionStartupBusy, releaseRejectedNativeStartupRunLeases, settleNativeSessionStartupBusy, withHeartbeatRunExecution } from "./heartbeat-run-execution.js";
import { NativeSessionStartupBusyError } from "./native-runtime/native-goal-delivery-hold.js";

describe("heartbeat run execution entry", () => {
  it("admits one owner before the first await and lets a different run progress", async () => {
    const active = new Set<string>();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const winner = vi.fn(async () => { await barrier; });
    const loser = vi.fn(async () => undefined);
    const other = vi.fn(async () => undefined);
    const first = withHeartbeatRunExecution(active, "same-run", winner);
    expect(active.has("same-run")).toBe(true);
    await withHeartbeatRunExecution(active, "same-run", loser);
    await withHeartbeatRunExecution(active, "other-run", other);
    expect(winner).toHaveBeenCalledTimes(1);
    expect(loser).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(1);
    expect(active.has("same-run")).toBe(true);
    release();
    await first;
    expect(active.size).toBe(0);
  });

  it("releases its own entry after an exception without retaining a false owner", async () => {
    const active = new Set<string>();
    await expect(withHeartbeatRunExecution(active, "run", async () => {
      throw new Error("admission failed");
    })).rejects.toThrow("admission failed");
    expect(active.size).toBe(0);
    const next = vi.fn(async () => undefined);
    await withHeartbeatRunExecution(active, "run", next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("native startup contention after a run was claimed", () => {
  const freshCoordinator = { phase: "observed", attempt: 0, leaseOwner: null, resultId: null };

  it("requires an untouched current-run coordinator and excludes restart reattachment", () => {
    expect(canSettleNativeSessionStartupBusy({ scope: "owner_scope", isRestartRecovery: false,
      coordinator: freshCoordinator })).toBe(true);
    expect(canSettleNativeSessionStartupBusy({ scope: "session_scope", isRestartRecovery: false,
      coordinator: freshCoordinator })).toBe(true);
    expect(canSettleNativeSessionStartupBusy({ scope: "same_run", isRestartRecovery: false,
      coordinator: freshCoordinator })).toBe(false);
    expect(canSettleNativeSessionStartupBusy({ scope: "owner_scope", isRestartRecovery: true,
      coordinator: freshCoordinator })).toBe(false);
    expect(canSettleNativeSessionStartupBusy({ scope: "owner_scope", isRestartRecovery: false,
      coordinator: { ...freshCoordinator, attempt: 1 } })).toBe(false);
    expect(canSettleNativeSessionStartupBusy({ scope: "owner_scope", isRestartRecovery: false,
      coordinator: { ...freshCoordinator, leaseOwner: "reattached-controller" } })).toBe(false);
    expect(canSettleNativeSessionStartupBusy({ scope: "owner_scope", isRestartRecovery: false,
      coordinator: null })).toBe(false);
  });

  it("settles a post-lease retirement refusal only for its exact fresh lease", () => {
    const startedAt = new Date(Date.now() - 1000);
    const ownedLease = { owner: "new-run-owner", attempt: 1, controllerBootId: "boot",
      controllerPid: 42, controllerProcessStartedAt: startedAt };
    const coordinator = { phase: "observed", resultId: null, leaseOwner: ownedLease.owner,
      attempt: ownedLease.attempt, controllerBootId: ownedLease.controllerBootId,
      controllerPid: ownedLease.controllerPid, controllerProcessStartedAt: startedAt,
      leaseExpiresAt: new Date(Date.now() + 60_000) };
    const input = { scope: "owner_scope" as const, isRestartRecovery: false, ownedLease, coordinator };
    expect(canSettleNativeSessionStartupBusy(input)).toBe(true);
    expect(canSettleNativeSessionStartupBusy({ ...input, coordinator: { ...coordinator, leaseOwner: "winner" } })).toBe(false);
    expect(canSettleNativeSessionStartupBusy({ ...input, coordinator: { ...coordinator, resultId: "receipt" } })).toBe(false);
    expect(canSettleNativeSessionStartupBusy({ ...input, coordinator: { ...coordinator, leaseExpiresAt: new Date(0) } })).toBe(false);
    expect(canSettleNativeSessionStartupBusy({ ...input, isRestartRecovery: true })).toBe(false);
  });

  it("defers a duplicate of the same run while releasing only its local reservation", async () => {
    const calls = {
      failCurrentRun: vi.fn(async () => true),
      failCurrentWakeup: vi.fn(async () => undefined),
      releaseCurrentIssue: vi.fn(async () => undefined),
      finalizeAgent: vi.fn(async () => undefined),
      releaseCurrentReservation: vi.fn(async () => undefined),
    };
    expect(await settleNativeSessionStartupBusy(new NativeSessionStartupBusyError("same_run"), calls))
      .toBe("deferred");
    for (const [name, call] of Object.entries(calls)) {
      expect(call).toHaveBeenCalledTimes(name === "releaseCurrentReservation" ? 1 : 0);
    }
  });

  it("retains a reusable lease before releasing this run's other lease", async () => {
    const leases = new Map([["rejected-reusable", "reuse_by_environment"], ["rejected-ephemeral", "ephemeral"]]);
    const callOrder: string[] = [];
    const result = await releaseRejectedNativeStartupRunLeases({
      listCurrentRunLeases: async () => [...leases.values()].map(leasePolicy => ({ leasePolicy })),
      retainReusableLeases: vi.fn(async () => {
        callOrder.push("retain");
        leases.delete("rejected-reusable");
      }),
      releaseNonReusableLeases: vi.fn(async () => {
        callOrder.push("release");
        leases.delete("rejected-ephemeral");
      }),
    });
    expect(result).toBe("released");
    expect(callOrder).toEqual(["retain", "release"]);
    expect(leases.size).toBe(0);
  });

  it("keeps other lease cleanup behind an unresolved reusable lease", async () => {
    const releaseOther = vi.fn(async () => undefined);
    const result = await releaseRejectedNativeStartupRunLeases({
      listCurrentRunLeases: async () => [{ leasePolicy: "reuse_by_environment" }, { leasePolicy: "ephemeral" }],
      retainReusableLeases: vi.fn(async () => undefined),
      releaseNonReusableLeases: releaseOther,
    });
    expect(result).toBe("shared_lease_unresolved");
    expect(releaseOther).not.toHaveBeenCalled();
  });

  it.each(["owner_scope", "session_scope"] as const)(
    "settles the rejected %s run in order and releases its reservation",
    async scope => {
      const runs = new Map([["rejected", "running"]]);
      const reservations = new Set(["rejected"]);
      const callOrder: string[] = [];
      const calls = {
        failCurrentRun: vi.fn(async () => {
          callOrder.push("run");
          runs.set("rejected", "failed");
          return true;
        }),
        failCurrentWakeup: vi.fn(async () => { callOrder.push("wake"); }),
        releaseCurrentIssue: vi.fn(async () => { callOrder.push("issue"); }),
        finalizeAgent: vi.fn(async () => { callOrder.push("agent"); }),
        releaseCurrentReservation: vi.fn(async () => {
          callOrder.push("reservation");
          reservations.delete("rejected");
        }),
      };
      expect(await settleNativeSessionStartupBusy(new NativeSessionStartupBusyError(scope), calls))
        .toBe("settled");
      expect(calls.failCurrentRun).toHaveBeenCalledOnce();
      expect(calls.failCurrentWakeup).toHaveBeenCalledOnce();
      expect(calls.releaseCurrentIssue).toHaveBeenCalledOnce();
      expect(calls.finalizeAgent).toHaveBeenCalledOnce();
      expect(calls.releaseCurrentReservation).toHaveBeenCalledOnce();
      expect(callOrder).toEqual(["run", "wake", "issue", "agent", "reservation"]);
      expect(reservations.size).toBe(0);
      expect(runs.get("rejected")).toBe("failed");
    },
  );

  it("releases local preparation but defers shared cleanup when the current-run ownership check loses", async () => {
    const calls = {
      failCurrentRun: vi.fn(async () => false),
      failCurrentWakeup: vi.fn(async () => undefined),
      releaseCurrentIssue: vi.fn(async () => undefined),
      finalizeAgent: vi.fn(async () => undefined),
      releaseCurrentReservation: vi.fn(async () => undefined),
    };
    expect(await settleNativeSessionStartupBusy(new NativeSessionStartupBusyError("owner_scope"), calls))
      .toBe("deferred");
    expect(calls.failCurrentRun).toHaveBeenCalledOnce();
    expect(calls.failCurrentWakeup).not.toHaveBeenCalled();
    expect(calls.releaseCurrentIssue).not.toHaveBeenCalled();
    expect(calls.finalizeAgent).not.toHaveBeenCalled();
    expect(calls.releaseCurrentReservation).toHaveBeenCalledOnce();
  });

  it("continues the rejected run's issue and reservation cleanup when wake settlement fails", async () => {
    const wakeError = new Error("wake update failed");
    const calls = {
      failCurrentRun: vi.fn(async () => true),
      failCurrentWakeup: vi.fn(async () => { throw wakeError; }),
      releaseCurrentIssue: vi.fn(async () => undefined),
      finalizeAgent: vi.fn(async () => undefined),
      releaseCurrentReservation: vi.fn(async () => undefined),
    };
    await expect(settleNativeSessionStartupBusy(new NativeSessionStartupBusyError("owner_scope"), calls))
      .rejects.toBe(wakeError);
    expect(calls.releaseCurrentIssue).toHaveBeenCalledOnce();
    expect(calls.finalizeAgent).toHaveBeenCalledOnce();
    expect(calls.releaseCurrentReservation).toHaveBeenCalledOnce();
  });
});
