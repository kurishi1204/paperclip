import { expect, it, vi } from "vitest";
import { isAcknowledgedNativeReassignmentStop, isAcknowledgedNativeStop } from "./acknowledged-native-stop.js";
const run = { id: "run", companyId: "company", nativeIssueId: "issue", status: "cancelled", resultJson: {
  cancelledByActorType: "user", cancelledByUserId: "board", nativeCancellation: {
    schema: "paperclip.native-cancellation.v1", runId: "run", companyId: "company", issueId: "issue",
    scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
    intentAuditId: "intent", acknowledgementAuditId: "ack",
  },
} };
it("recognizes the native receipt used by the Stop button", () => {
  expect(isAcknowledgedNativeStop(run)).toBe(true);
});
it.each([{ runId: "other" }, { companyId: "other" }, { issueId: "other" }, { dispatchState: "pending" },
  { scope: "subtree" }, { acknowledgementAuditId: undefined }])("refuses unrelated or incomplete receipts %j", change => {
  expect(isAcknowledgedNativeStop({ ...run, resultJson: { ...run.resultJson,
    nativeCancellation: { ...run.resultJson.nativeCancellation, ...change } } })).toBe(false);
});

it("recognizes an audited handoff without granting operator Stop semantics", () => {
  const handoff = { ...run, resultJson: { reassignmentStopRequested: true, nativeCancellation: run.resultJson.nativeCancellation } };
  expect(isAcknowledgedNativeReassignmentStop(handoff)).toBe(true);
  expect(isAcknowledgedNativeStop(handoff)).toBe(false);
  expect(isAcknowledgedNativeReassignmentStop({ ...handoff, status: "running" })).toBe(false);
  expect(isAcknowledgedNativeReassignmentStop(run)).toBe(false);
});
it.each([{ runId: "other" }, { companyId: "other" }, { issueId: "other" }, { dispatchState: "pending" },
  { scope: "subtree" }, { acknowledgementAuditId: undefined }])("requires an audited handoff receipt %j", change => {
  expect(isAcknowledgedNativeReassignmentStop({ ...run, resultJson: { reassignmentStopRequested: true,
    nativeCancellation: { ...run.resultJson.nativeCancellation, ...change } } })).toBe(false);
});

const receivedExitEvents = vi.hoisted(() => [] as Array<Record<string, any>>);
vi.mock("./heartbeat-run-events.js", () => ({ appendHeartbeatRunEvent: vi.fn(async (_db, event) => { receivedExitEvents.push(event); }) }));
import { environmentLeases, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { recordNativeLocalProcessStop, readNativeLocalProcessStop } from "./native-local-process-stop.js";
import { runnerdRecoveryInternals } from "@paperclipai/paperclip-runner/live";

it.each(["matching", "different_runner", "different_start"])("connects owned completion to the existing stop receipt consumer: %s", async mode => {
  receivedExitEvents.length = 0;
  const identity = { runnerInstanceId: "original-runner", environmentLeaseId: "lease", runId: "original-run",
    normalizedSessionId: "original-session", turnId: "turn", itemId: "item" };
  const startedAt = "2026-11-17T01:00:00.000Z";
  const originalRun = { id: identity.runId, companyId: "company", agentId: "agent", nativeIssueId: "issue",
    nativeSessionId: identity.normalizedSessionId, runnerInstanceId: identity.runnerInstanceId, runtimeMode: "native",
    processPid: 550001, processGroupId: 550001, processStartedAt: new Date(startedAt) };
  const row = { ...originalRun,
    ...(mode === "different_runner" ? { runnerInstanceId: "new-carrier" } : {}),
    ...(mode === "different_start" ? { processStartedAt: new Date("2026-11-17T02:00:00.000Z") } : {}),
  };
  const db = { select() {
    let table: unknown;
    const q = { from(value: unknown) { table = value; return q; }, where() { return q; }, orderBy() { return q; }, limit() { return q; },
      then(resolve: (rows: unknown[]) => unknown) { return Promise.resolve(table === environmentLeases ? [{ provider: "local" }]
        : table === heartbeatRunEvents ? receivedExitEvents : table === heartbeatRuns ? [row] : []).then(resolve); } };
    return q;
  } } as unknown as Parameters<typeof recordNativeLocalProcessStop>[0];
  const absent = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("fixture-only absent"), { code: "ESRCH" }); });
  try {
    const receive = vi.fn(async (receipt) => {
      const recorded = await recordNativeLocalProcessStop(db, row as unknown as Parameters<typeof recordNativeLocalProcessStop>[1], receipt);
      if (!recorded) throw new Error("native_owned_process_exit_unverified");
    });
    const publish = runnerdRecoveryInternals.createOwnedProcessExitPublisher(receive);
    const handle = { child: { pid: originalRun.processPid, exitCode: 0, signalCode: null, kill: vi.fn() },
      processGroupId: originalRun.processGroupId,
      completion: Promise.resolve({ code: 0, signal: null, stdout: "PRIVATE_STDOUT", stderr: "PRIVATE_STDERR" }) };
    if (mode === "matching") {
      await publish(handle, identity, { pid: originalRun.processPid, processGroupId: originalRun.processGroupId, startedAt });
      await publish(handle, { ...identity, runId: "unrelated-carrier" }, null);
      expect(receive).toHaveBeenCalledOnce();
      expect(receivedExitEvents).toHaveLength(1);
      const read = await readNativeLocalProcessStop(db, "company", identity.runId);
      expect(read).toMatchObject({ processPid: originalRun.processPid, terminationReceipt: { identity, processStartedAt: startedAt, exitCode: 0, signal: null } });
      expect(JSON.stringify(read)).not.toContain("PRIVATE_");
      expect(JSON.stringify(receivedExitEvents)).not.toContain("unrelated-carrier");
    } else {
      await expect(publish(handle, identity, { pid: originalRun.processPid, processGroupId: originalRun.processGroupId, startedAt })).rejects.toThrow("native_owned_process_exit_unverified");
      expect(receivedExitEvents).toHaveLength(0);
    }
  } finally { absent.mockRestore(); }
});

it.each(["missing_generation", "missing_identity", "unknown_exit", "callback_unknown"])("does not promote or resend unverified owned termination: %s", async mode => {
  const receive = vi.fn(async () => { if (mode === "callback_unknown") throw new Error("receipt outcome unknown"); });
  const publish = runnerdRecoveryInternals.createOwnedProcessExitPublisher(receive);
  const identity = { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run", normalizedSessionId: "session", turnId: "turn", itemId: "item" };
  const handle = { child: { pid: 550002, exitCode: mode === "unknown_exit" ? null : 0, signalCode: null, kill: vi.fn() }, processGroupId: 550002,
    completion: Promise.resolve({ code: mode === "unknown_exit" ? null : 0, signal: null, stdout: "", stderr: "" }) };
  const args = [handle, mode === "missing_identity" ? null : identity,
    mode === "missing_generation" ? null : { pid: 550002, processGroupId: 550002, startedAt: "2026-11-17T01:00:00Z" }] as const;
  await expect(publish(...args)).rejects.toThrow();
  await expect(publish(...args)).rejects.toThrow();
  expect(receive).toHaveBeenCalledTimes(mode === "callback_unknown" ? 1 : 0);
});
