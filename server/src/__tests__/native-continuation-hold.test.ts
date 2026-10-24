import { randomUUID } from "node:crypto";
import { and, eq, not } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, completionContracts, createDb, heartbeatRuns, issues,
  issueThreadInteractions, nativeRunFinalizations, nativeRunResults, statusDecisions,
  workAssessments, type Db,
} from "@paperclipai/db";
import {
  hasNativeContinuationIssueAuthority, isNativeContinuationHeld,
  nativeContinuationHoldSql, readNativeContinuationHold, readNativeContinuationIssueAuthority,
  type NativeContinuationAuthorityFacts, type NativeContinuationHoldFacts,
} from "../services/native-runtime/native-continuation-hold.js";
import * as review from "../services/native-runtime/native-review-participant.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const agentId = "44444444-4444-4444-8444-444444444444";
const otherId = "55555555-5555-4555-8555-555555555555";
const reviewContext = {
  nativeReviewInteractionId: "66666666-6666-4666-8666-666666666666",
  nativeReviewDecisionId: "77777777-7777-4777-8777-777777777777",
};

function facts(): NativeContinuationHoldFacts {
  return {
    issue: { id: issueId, companyId, status: "blocked", assigneeAgentId: agentId,
      assigneeUserId: null, executionRunId: runId, checkoutRunId: null },
    run: { id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", contextSnapshot: null },
    finalization: { runId, companyId, issueId, phase: "retryable_failure", resultId: null,
      recoveryState: "resuming_session", leaseOwner: null, failureDetail: null },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("native continuation hold facts", () => {
  it("retains an assignee's result-less retryable native continuation", () => {
    expect(isNativeContinuationHeld(facts())).toBe(true);
    const input = facts(); input.issue.checkoutRunId = runId;
    expect(isNativeContinuationHeld(input)).toBe(true);
  });

  const rejected: Array<[string, (f: NativeContinuationHoldFacts) => void]> = [
    ["missing run", f => { f.run = null; }],
    ["missing finalization", f => { f.finalization = null; }],
    ["other run company", f => { f.run!.companyId = otherId; }],
    ["other native issue", f => { f.run!.nativeIssueId = otherId; }],
    ["legacy run", f => { f.run!.runtimeMode = "legacy"; }],
    ["running is not this hold", f => { f.run!.status = "running"; }],
    ["succeeded run", f => { f.run!.status = "succeeded"; }],
    ["other F run", f => { f.finalization!.runId = otherId; }],
    ["other F company", f => { f.finalization!.companyId = otherId; }],
    ["other F issue", f => { f.finalization!.issueId = otherId; }],
    ["observed F", f => { f.finalization!.phase = "observed"; }],
    ["terminal F", f => { f.finalization!.phase = "terminal_failure"; }],
    ["result-bearing F", f => { f.finalization!.resultId = otherId; }],
    ["not resuming", f => { f.finalization!.recoveryState = "blocked"; }],
    ["unrelinquished lease", f => { f.finalization!.leaseOwner = "expired-controller"; }],
    ["successor", f => { f.finalization!.failureDetail = { successorRunId: otherId }; }],
    ["replacement denied", f => { f.finalization!.failureDetail = { replacementDenied: "denied" }; }],
    ["false is not an empty successor", f => { f.finalization!.failureDetail = { successorRunId: false }; }],
    ["zero is not an empty denial", f => { f.finalization!.failureDetail = { replacementDenied: 0 }; }],
    ["whitespace is not empty", f => { f.finalization!.failureDetail = { successorRunId: " " }; }],
    ["done", f => { f.issue.status = "done"; }],
    ["cancelled", f => { f.issue.status = "cancelled"; }],
    ["lost execution binding", f => { f.issue.executionRunId = null; }],
    ["competing execution binding", f => { f.issue.executionRunId = otherId; }],
    ["competing checkout binding", f => { f.issue.checkoutRunId = otherId; }],
  ];
  it.each(rejected)("rejects %s", (_name, mutate) => {
    const input = facts(); mutate(input); expect(isNativeContinuationHeld(input)).toBe(false);
  });

  it.each([null, {}, { successorRunId: null, replacementDenied: "" }])("accepts empty failure markers %j", detail => {
    const input = facts(); input.finalization!.failureDetail = detail;
    expect(isNativeContinuationHeld(input)).toBe(true);
  });

  it("retains the binding while separately requiring valid current reviewer dispatch authority", () => {
    const input = facts(); input.issue.status = "in_review"; input.issue.assigneeAgentId = otherId;
    input.run!.contextSnapshot = reviewContext;
    expect(isNativeContinuationHeld(input)).toBe(true);
    expect(hasNativeContinuationIssueAuthority(input)).toBe(false);
    expect(hasNativeContinuationIssueAuthority({ ...input, reviewAssignmentValid: true })).toBe(true);
  });

  const revoked: Array<[string, (f: NativeContinuationAuthorityFacts) => void]> = [
    ["human assignee", f => { f.issue.assigneeUserId = "synthetic-user"; }],
    ["changed assignee", f => { f.issue.assigneeAgentId = otherId; }],
    ["no assignee", f => { f.issue.assigneeAgentId = null; }],
    ["review context alone", f => { f.issue.assigneeAgentId = otherId; f.run!.contextSnapshot = reviewContext; }],
    ["review boolean without context", f => { f.issue.assigneeAgentId = otherId; f.reviewAssignmentValid = true; }],
    ["malformed review context", f => { f.issue.assigneeAgentId = otherId; f.reviewAssignmentValid = true; f.run!.contextSnapshot = { ...reviewContext, nativeReviewDecisionId: "bad" }; }],
  ];
  it.each(revoked)("retains existing binding but refuses dispatch for %s", (_name, mutate) => {
    const input = facts(); mutate(input);
    expect(isNativeContinuationHeld(input)).toBe(true);
    expect(hasNativeContinuationIssueAuthority(input)).toBe(false);
  });

  it("leaves running/failed and coordinator qualification to the claim consumer", () => {
    const input = facts(); input.run!.status = "running";
    input.finalization!.phase = "observed"; input.finalization!.leaseOwner = "controller";
    expect(hasNativeContinuationIssueAuthority(input)).toBe(true);
    expect(isNativeContinuationHeld(input)).toBe(false);
  });

  it("does not use next-attempt time or process IDs as hold authority", () => {
    for (const nextAttemptAt of [new Date(0), new Date("2100-01-01")]) {
      const input = facts();
      const finalization = { ...input.finalization!, nextAttemptAt, controllerPid: 999999 };
      const run = { ...input.run!, processPid: 12345, processGroupId: 12345 };
      expect(isNativeContinuationHeld({ ...input, finalization, run })).toBe(true);
    }
  });
});

function readOnlyDb(populations: unknown[][]) {
  const select = vi.fn(() => {
    const rows = populations.shift();
    if (rows === undefined) throw new Error("unexpected additional read");
    return { from: () => ({ where: () => ({ limit: async () => rows }) }) };
  });
  return { db: { select } as unknown as Db, select };
}

describe("native hold read helper", () => {
  it("does not read or ask for review when the execution binding is lost", async () => {
    const input = facts(); input.issue.executionRunId = null;
    const db = readOnlyDb([]); const assignment = vi.spyOn(review, "getNativeReviewAssignment");
    expect(await readNativeContinuationHold(db.db, { issue: input.issue, runId })).toBe(false);
    expect(db.select).not.toHaveBeenCalled(); expect(assignment).not.toHaveBeenCalled();
  });

  it("performs only two plain reads for the assignee branch", async () => {
    const input = facts(), db = readOnlyDb([[input.run], [input.finalization]]);
    const assignment = vi.spyOn(review, "getNativeReviewAssignment");
    expect(await readNativeContinuationHold(db.db, { issue: input.issue, runId })).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(2); expect(assignment).not.toHaveBeenCalled();
  });

  it("never asks the reviewer subsystem for retention, while dispatch keeps the existing strict contract", async () => {
    const input = facts(); input.issue.assigneeAgentId = otherId; input.run!.contextSnapshot = reviewContext;
    const db = readOnlyDb([[input.run], [input.finalization]]);
    const assignment = vi.spyOn(review, "getNativeReviewAssignment").mockResolvedValue({} as review.NativeReviewAssignment);
    expect(await readNativeContinuationHold(db.db, { issue: input.issue, runId })).toBe(true);
    expect(assignment).not.toHaveBeenCalled();
    expect(await readNativeContinuationIssueAuthority(db.db, input)).toBe(true);
    expect(assignment).toHaveBeenCalledExactlyOnceWith(db.db, { companyId, issueId, agentId, contextSnapshot: reviewContext });
    assignment.mockResolvedValue(null);
    expect(await readNativeContinuationIssueAuthority(db.db, input)).toBe(false);
  });

  it("rejects coordinator mismatch before asking the reviewer subsystem", async () => {
    const input = facts(); input.issue.assigneeAgentId = otherId; input.run!.contextSnapshot = reviewContext;
    input.finalization!.leaseOwner = "unrelinquished";
    const db = readOnlyDb([[input.run], [input.finalization]]);
    const assignment = vi.spyOn(review, "getNativeReviewAssignment");
    expect(await readNativeContinuationHold(db.db, { issue: input.issue, runId })).toBe(false);
    expect(assignment).not.toHaveBeenCalled();
  });
});

describe("native retention SQL equivalence in isolated PostgreSQL", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const company = randomUUID(), agent = randomUUID(), reviewer = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-hold-unit-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: company, name: "Synthetic hold predicate", issuePrefix: "NHP" });
    await db.insert(agents).values([
      { id: agent, companyId: company, name: "Synthetic assignee", status: "active", adapterType: "process" },
      { id: reviewer, companyId: company, name: "Synthetic reviewer", status: "active", adapterType: "process" },
    ]);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function seed() {
    const issue = randomUUID(), run = randomUUID();
    await db.insert(issues).values({ id: issue, companyId: company, title: "Retain synthetic continuation", status: "blocked", assigneeAgentId: agent });
    await db.insert(heartbeatRuns).values({ id: run, companyId: company, agentId: agent, nativeIssueId: issue, runtimeMode: "native", status: "failed" });
    await db.update(issues).set({ executionRunId: run }).where(eq(issues.id, issue));
    await db.insert(nativeRunFinalizations).values({ runId: run, companyId: company, issueId: issue, phase: "retryable_failure", recoveryState: "resuming_session" });
    return { issue, run };
  }

  const cases = [
    { name: "normal", expected: true },
    { name: "self checkout", expected: true, checkoutSelf: true },
    { name: "future retry date", expected: true, future: true },
    { name: "done", expected: false, issue: { status: "done" } },
    { name: "cancelled", expected: false, issue: { status: "cancelled" } },
    { name: "lost binding", expected: false, issue: { executionRunId: null } },
    { name: "changed assignee without explicit clear", expected: true, changeAssignee: true },
    { name: "no assignee without explicit clear", expected: true, issue: { assigneeAgentId: null } },
    { name: "running", expected: false, run: { status: "running" } },
    { name: "legacy", expected: false, run: { runtimeMode: "legacy" } },
    { name: "observed", expected: false, finalization: { phase: "observed" } },
    { name: "terminal", expected: false, finalization: { phase: "terminal_failure" } },
    { name: "lease retained", expected: false, finalization: { leaseOwner: "expired-but-not-relinquished" } },
    { name: "not resuming", expected: false, finalization: { recoveryState: "blocked" } },
    { name: "empty strings", expected: true, finalization: { failureDetail: { successorRunId: "", replacementDenied: "" } } },
    { name: "JSON null", expected: true, finalization: { failureDetail: { successorRunId: null, replacementDenied: null } } },
    { name: "successor false", expected: false, finalization: { failureDetail: { successorRunId: false } } },
    { name: "denial zero", expected: false, finalization: { failureDetail: { replacementDenied: 0 } } },
    { name: "denial true", expected: false, finalization: { failureDetail: { replacementDenied: true } } },
    { name: "successor text", expected: false, finalization: { failureDetail: { successorRunId: otherId } } },
  ];
  it.each(cases)("matches pure/read/SQL retention semantics for $name", async scenario => {
    const ids = await seed();
    if (scenario.issue) await db.update(issues).set(scenario.issue).where(eq(issues.id, ids.issue));
    if (scenario.run) await db.update(heartbeatRuns).set(scenario.run).where(eq(heartbeatRuns.id, ids.run));
    if (scenario.finalization) await db.update(nativeRunFinalizations).set(scenario.finalization).where(eq(nativeRunFinalizations.runId, ids.run));
    if (scenario.checkoutSelf) await db.update(issues).set({ checkoutRunId: ids.run }).where(eq(issues.id, ids.issue));
    if (scenario.changeAssignee) await db.update(issues).set({ assigneeAgentId: reviewer }).where(eq(issues.id, ids.issue));
    if (scenario.future) await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date("2100-01-01") }).where(eq(nativeRunFinalizations.runId, ids.run));
    const [issue] = await db.select().from(issues).where(eq(issues.id, ids.issue));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.run));
    const [finalization] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, ids.run));
    const before = JSON.stringify({ issue, run, finalization });
    const pure = isNativeContinuationHeld({ issue, run, finalization });
    const read = await db.transaction(tx => readNativeContinuationHold(tx, { issue, runId: ids.run }));
    const [row] = await db.select({ held: nativeContinuationHoldSql() }).from(issues).where(eq(issues.id, ids.issue));
    expect([pure, read, row.held]).toEqual([scenario.expected, scenario.expected, scenario.expected]);
    const [afterI] = await db.select().from(issues).where(eq(issues.id, ids.issue));
    const [afterR] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.run));
    const [afterF] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, ids.run));
    expect(JSON.stringify({ issue: afterI, run: afterR, finalization: afterF })).toBe(before);
    const guarded = await db.update(issues).set({ title: "Synthetic SQL fence control" })
      .where(and(eq(issues.id, ids.issue), not(nativeContinuationHoldSql())))
      .returning({ id: issues.id });
    expect(guarded).toHaveLength(scenario.expected ? 0 : 1);
  });

  it("retains reviewer binding across pause/resume and review expiry without relaxing dispatch", async () => {
    const ids = await seed(), contract = randomUUID(), result = randomUUID(), assessment = randomUUID();
    const sourceRun = randomUUID(), decision = randomUUID(), interaction = randomUUID();
    await db.insert(completionContracts).values({ id: contract, companyId: company, issueId: ids.issue, revision: 1, schemaVersion: "fixture", policyVersion: "fixture", risk: "low", completionAuthority: "fixture", incompleteCriteriaPolicy: "fixture", contractJson: {}, canonicalSha256: contract, createdByActorType: "system", createdByActorId: "fixture" });
    await db.insert(heartbeatRuns).values({ id: sourceRun, companyId: company, agentId: agent, nativeIssueId: ids.issue, runtimeMode: "native", status: "succeeded", completionContractId: contract, completionContractSha256: contract });
    await db.insert(nativeRunResults).values({ id: result, companyId: company, issueId: ids.issue, runId: sourceRun, completionContractId: contract, serverFingerprint: result, schemaStatus: "accepted", resultJson: {}, canonicalSha256: result });
    await db.insert(workAssessments).values({ id: assessment, companyId: company, issueId: ids.issue, runId: sourceRun, contractId: contract, resultId: result, triggerKind: "native_result", triggerActorCompanyId: company, priorIssueStatus: "blocked", priorStatusVersion: 0, policyVersion: "fixture", assessmentJson: {}, inputDigest: assessment });
    const [updated] = await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, ids.issue)).returning();
    await db.insert(statusDecisions).values({ id: decision, companyId: company, issueId: ids.issue, runId: sourceRun, assessmentId: assessment, decisionVersion: 1, policyVersion: "fixture", fromStatus: "blocked", toStatus: "in_review", reasonCode: "explicit_review", decisionJson: { projectedStatusVersion: updated.statusVersion }, decisionDigest: decision, applicationState: "applied" });
    await db.update(issues).set({ lastStatusDecisionId: decision }).where(eq(issues.id, ids.issue));
    await db.insert(issueThreadInteractions).values({ id: interaction, companyId: company, issueId: ids.issue, kind: "request_confirmation", sourceRunId: sourceRun, addresseeAgentId: reviewer, createdByAgentId: agent, continuationPolicy: "wake_assignee", status: "pending", effectiveResolverPolicy: "anyone", resolverPolicyProvenance: "inherited", payload: { version: 1, prompt: "Synthetic review", target: { type: "custom", key: "native_completion_review", revisionId: decision } } });
    await db.update(heartbeatRuns).set({ agentId: reviewer, contextSnapshot: { nativeReviewInteractionId: interaction, nativeReviewDecisionId: decision } }).where(eq(heartbeatRuns.id, ids.run));
    const [issue] = await db.select().from(issues).where(eq(issues.id, ids.issue));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.run));
    expect(await db.transaction(tx => readNativeContinuationHold(tx, { issue, runId: ids.run }))).toBe(true);
    const [sqlRow] = await db.select({ held: nativeContinuationHoldSql() }).from(issues).where(eq(issues.id, ids.issue));
    expect(sqlRow.held).toBe(true);
    expect(await readNativeContinuationIssueAuthority(db, { issue, run })).toBe(true);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewer));
    expect(await readNativeContinuationIssueAuthority(db, { issue, run })).toBe(false);
    expect(await readNativeContinuationHold(db, { issue, runId: ids.run })).toBe(true);
    const [paused] = await db.select({ held: nativeContinuationHoldSql() }).from(issues).where(eq(issues.id, ids.issue));
    expect(paused.held).toBe(true);
    await db.update(agents).set({ status: "active" }).where(eq(agents.id, reviewer));
    expect(await readNativeContinuationIssueAuthority(db, { issue, run })).toBe(true);
    await db.update(issueThreadInteractions).set({ status: "accepted" }).where(and(eq(issueThreadInteractions.id, interaction), eq(issueThreadInteractions.companyId, company)));
    expect(await readNativeContinuationIssueAuthority(db, { issue, run })).toBe(false);
    expect(await readNativeContinuationHold(db, { issue, runId: ids.run })).toBe(true);
  });
});
