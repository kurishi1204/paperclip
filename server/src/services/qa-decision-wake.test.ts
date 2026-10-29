import { describe, expect, it } from "vitest";
import { agentWakeupRequests, issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { IssueExecutionState } from "@paperclipai/shared";
import {
  buildQaChangesRequestedWakeContext,
  buildQaPreProviderRecovery,
  isAuthorizedQaDecisionWake,
  isCurrentQaChangesRequestedDecision,
  qaDecisionWakeBlocksDelivery,
  qaDecisionIdFromWakeKey,
  qaDecisionWakeKey,
} from "./qa-decision-wake.js";

const preProviderRun = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  runtimeMode: "legacy",
  contextSnapshot: { qaDecisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", forceFreshSession: true },
};

describe("QA pre-provider recovery evidence", () => {
  it("binds a new host observation to this run and decision while preserving unrelated recovery fields", () => {
    const existingRecovery = { kind: "old_kind", providerWorkStarted: false, attempt: 2,
      detail: { retryAt: "synthetic-later" },
      qaPreProvider: { schema: "paperclip.qa-pre-provider/v1", runId: "other-run", decisionId: "other-decision" } };
    const before = structuredClone({ run: preProviderRun, existingRecovery });
    expect(buildQaPreProviderRecovery({ run: preProviderRun, kind: "bootstrap",
      providerMayHaveStarted: false, existingRecovery })).toEqual({
      kind: "bootstrap", providerWorkStarted: false, attempt: 2, detail: { retryAt: "synthetic-later" },
      qaPreProvider: { schema: "paperclip.qa-pre-provider/v1", runId: preProviderRun.id,
        decisionId: preProviderRun.contextSnapshot.qaDecisionId },
    });
    expect({ run: preProviderRun, existingRecovery }).toEqual(before);
  });

  it("creates evidence without inheriting an old false stamp", () => {
    expect(buildQaPreProviderRecovery({ run: preProviderRun, kind: "workspace_wait",
      providerMayHaveStarted: false })).toEqual({
      kind: "workspace_wait", providerWorkStarted: false,
      qaPreProvider: { schema: "paperclip.qa-pre-provider/v1", runId: preProviderRun.id,
        decisionId: preProviderRun.contextSnapshot.qaDecisionId },
    });
  });

  it.each([
    { providerMayHaveStarted: true, previous: false },
    { providerMayHaveStarted: false, previous: true },
    { providerMayHaveStarted: true, previous: true },
  ])("preserves possible provider work and removes stale proof for $providerMayHaveStarted/$previous", ({ providerMayHaveStarted, previous }) => {
    const projected = buildQaPreProviderRecovery({ run: preProviderRun, kind: "bootstrap",
      providerMayHaveStarted, existingRecovery: { providerWorkStarted: previous, retryAt: "synthetic-later",
        qaPreProvider: { schema: "paperclip.qa-pre-provider/v1", runId: preProviderRun.id,
          decisionId: preProviderRun.contextSnapshot.qaDecisionId } } });
    expect(projected).toEqual({ kind: "bootstrap", providerWorkStarted: true, retryAt: "synthetic-later" });
    expect(projected).not.toHaveProperty("qaPreProvider");
  });

  it.each([
    { label: "native", run: { ...preProviderRun, runtimeMode: "native" } },
    { label: "non-QA", run: { ...preProviderRun, contextSnapshot: { forceFreshSession: true } } },
    { label: "invalid decision", run: { ...preProviderRun, contextSnapshot: { qaDecisionId: "not-a-uuid", forceFreshSession: true } } },
    { label: "not fresh", run: { ...preProviderRun, contextSnapshot: { ...preProviderRun.contextSnapshot, forceFreshSession: false } } },
    { label: "string fresh", run: { ...preProviderRun, contextSnapshot: { ...preProviderRun.contextSnapshot, forceFreshSession: "true" } } },
    { label: "null context", run: { ...preProviderRun, contextSnapshot: null } },
    { label: "array context", run: { ...preProviderRun, contextSnapshot: [preProviderRun.contextSnapshot] } },
  ])("does not mint or retain QA proof for $label", ({ run }) => {
    expect(buildQaPreProviderRecovery({ run, kind: "bootstrap", providerMayHaveStarted: false,
      existingRecovery: { providerWorkStarted: false, attempt: 1, qaPreProvider: { schema: "old" } } }))
      .toEqual({ kind: "bootstrap", providerWorkStarted: false, attempt: 1 });
  });

  it("does not turn an omitted runtime observation into proof by inheriting false", () => {
    const projected = buildQaPreProviderRecovery({ run: preProviderRun, kind: "bootstrap",
      providerMayHaveStarted: undefined as unknown as boolean,
      existingRecovery: { providerWorkStarted: false } });
    expect(projected).toEqual({ kind: "bootstrap", providerWorkStarted: true });
  });

  it("binds each new observation to its current run and decision", () => {
    const run = { ...preProviderRun, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      contextSnapshot: { ...preProviderRun.contextSnapshot, qaDecisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } };
    const prior = buildQaPreProviderRecovery({ run: preProviderRun, kind: "bootstrap", providerMayHaveStarted: false });
    const projected = buildQaPreProviderRecovery({ run, kind: "bootstrap", providerMayHaveStarted: false,
      existingRecovery: prior });
    expect(projected.qaPreProvider).toEqual({ schema: "paperclip.qa-pre-provider/v1",
      runId: run.id, decisionId: run.contextSnapshot.qaDecisionId });
    expect(prior.qaPreProvider?.runId).toBe(preProviderRun.id);
  });
});

const changesRequestedState: IssueExecutionState = {
  status: "changes_requested",
  currentStageId: "11111111-1111-4111-8111-111111111111",
  currentStageIndex: 0,
  currentStageType: "review",
  currentParticipant: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222", userId: null },
  returnAssignee: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333", userId: null },
  reviewRequest: { instructions: "Revise the saved document and resubmit the same task for review." },
  completedStageIds: [],
  lastDecisionId: "44444444-4444-4444-8444-444444444444",
  lastDecisionOutcome: "changes_requested",
  changesRequestedCount: 1,
};

// Fixed contract from the normal route's changes_requested wake. Recovery must
// deliver this same context, rather than merely the issue ID and source label.
const normalChangesRequestedContext = {
  payload: {
    issueId: "issue-1",
    mutation: "update",
    executionStage: {
      wakeRole: "executor",
      stageId: changesRequestedState.currentStageId,
      stageType: "review",
      currentParticipant: changesRequestedState.currentParticipant,
      returnAssignee: changesRequestedState.returnAssignee,
      reviewRequest: changesRequestedState.reviewRequest,
      lastDecisionOutcome: "changes_requested",
      allowedActions: ["address_changes", "resubmit"],
    },
  },
  contextSnapshot: {
    issueId: "issue-1",
    taskId: "issue-1",
    wakeReason: "execution_changes_requested",
    source: "issue.execution_stage",
    executionStage: {
      wakeRole: "executor",
      stageId: changesRequestedState.currentStageId,
      stageType: "review",
      currentParticipant: changesRequestedState.currentParticipant,
      returnAssignee: changesRequestedState.returnAssignee,
      reviewRequest: changesRequestedState.reviewRequest,
      lastDecisionOutcome: "changes_requested",
      allowedActions: ["address_changes", "resubmit"],
    },
  },
};

describe("QA changes-requested wake context", () => {
  it("projects the full normal route contract from the current issue state", () => {
    expect(buildQaChangesRequestedWakeContext({ issueId: "issue-1", state: changesRequestedState }))
      .toEqual(normalChangesRequestedContext);
  });

  it.each([
    {
      caller: "stranded assignment recovery",
      payload: { issueId: "issue-1" },
      contextSnapshot: { issueId: "issue-1", taskId: "issue-1", wakeReason: "execution_changes_requested", source: "issue.execution_stage" },
    },
    {
      caller: "deferred decision recovery",
      payload: { issueId: "issue-1" },
      contextSnapshot: { issueId: "issue-1", source: "issue.execution_stage" },
    },
  ])("restores the missing normal context for $caller", (oldWake) => {
    expect(oldWake.contextSnapshot).not.toEqual(normalChangesRequestedContext.contextSnapshot);
    const projected = buildQaChangesRequestedWakeContext({ issueId: "issue-1", state: changesRequestedState });
    expect({
      payload: { ...oldWake.payload, ...projected.payload },
      contextSnapshot: { ...oldWake.contextSnapshot, ...projected.contextSnapshot },
    }).toEqual(normalChangesRequestedContext);
  });

  it("uses current state instead of stale caller context without mutating either", () => {
    const state = structuredClone(changesRequestedState);
    state.returnAssignee = { type: "agent", agentId: "55555555-5555-4555-8555-555555555555", userId: null };
    state.reviewRequest = { instructions: "Use the newly saved review evidence." };
    const stale = structuredClone(normalChangesRequestedContext.contextSnapshot);
    const before = structuredClone({ state, stale });
    const projected = buildQaChangesRequestedWakeContext({ issueId: "issue-1", state });
    const enriched = { ...stale, ...projected.contextSnapshot };
    expect(enriched.executionStage.returnAssignee).toEqual(state.returnAssignee);
    expect(enriched.executionStage.reviewRequest).toEqual(state.reviewRequest);
    expect(enriched.executionStage.currentParticipant).toEqual(state.currentParticipant);
    expect({ state, stale }).toEqual(before);
    // Context projection has no authority result, actor identity, or decision-ID claim.
    expect(projected).not.toHaveProperty("authorized");
    expect(projected).not.toHaveProperty("qaDecisionId");
    expect(projected).not.toHaveProperty("requestedByActorId");
  });

  it("retains the normal route's optional interrupted-run field and null review request", () => {
    const projected = buildQaChangesRequestedWakeContext({
      issueId: "issue-1", state: { ...changesRequestedState, reviewRequest: null }, interruptedRunId: "interrupted-run-1",
    });
    expect(projected.payload.interruptedRunId).toBe("interrupted-run-1");
    expect(projected.contextSnapshot.interruptedRunId).toBe("interrupted-run-1");
    expect(projected.payload.executionStage.reviewRequest).toBeNull();
    expect(projected.contextSnapshot.executionStage).toEqual(projected.payload.executionStage);
    const withoutInterruption = buildQaChangesRequestedWakeContext({ issueId: "issue-1", state: changesRequestedState });
    expect(withoutInterruption.payload).not.toHaveProperty("interruptedRunId");
    expect(withoutInterruption.contextSnapshot).not.toHaveProperty("interruptedRunId");
  });
});

const current = {
  companyId: "company-1", issueId: "issue-1", agentId: "worker-1",
  decisionId: "decision-1", decision: {
    id: "decision-1", companyId: "company-1", issueId: "issue-1",
    stageId: "stage-1", stageType: "review", outcome: "changes_requested",
    freshEpisodeWakeRequested: true,
  },
  issue: {
    id: "issue-1", companyId: "company-1", status: "in_progress",
    assigneeAgentId: "worker-1",
    executionState: {
      status: "changes_requested", currentStageId: "stage-1",
      lastDecisionId: "decision-1", returnAssignee: { type: "agent", agentId: "worker-1" },
    },
  },
} as const;

describe("QA decision wake authority", () => {
  it("holds unknown or started receipts while admitting only settled pre-provider terminals", () => {
    const rendered = new PgDialect().sqlToQuery(sql`select 1 from ${agentWakeupRequests} where ${qaDecisionWakeBlocksDelivery()}`);
    expect(rendered.sql).toContain("status\" in ('failed','cancelled','skipped')");
    expect(rendered.sql).toContain("claimed_at\" is null");
    expect(rendered.sql).toContain("finished_at\" is not null");
    expect(rendered.sql).toContain("qa_prior_run.started_at is null");
    expect(rendered.sql).toContain("qa_prior_run.wakeup_request_id =");
    expect(rendered.sql).toMatch(/qa_prior_run\.status in \(\$\d+, \$\d+, \$\d+, \$\d+\)/);
    expect(rendered.params).toEqual(["failed", "cancelled", "interrupted", "timed_out"]);
    expect(rendered.sql).toContain("qa_other_run.wakeup_request_id =");
    expect(rendered.sql).toContain("process_started_at is null");
  });

  it("accepts only the committed current decision for the return assignee", () => {
    expect(isCurrentQaChangesRequestedDecision(current)).toBe(true);
    expect(isCurrentQaChangesRequestedDecision({ ...current, agentId: "other" })).toBe(false);
    expect(isCurrentQaChangesRequestedDecision({ ...current, decision: { ...current.decision, outcome: "approved" } })).toBe(false);
    expect(isCurrentQaChangesRequestedDecision({ ...current, decision: { ...current.decision, freshEpisodeWakeRequested: false } })).toBe(false);
    expect(isCurrentQaChangesRequestedDecision({ ...current, issue: { ...current.issue, executionState: { ...current.issue.executionState, lastDecisionId: "later" } } })).toBe(false);
    expect(isCurrentQaChangesRequestedDecision({ ...current, issue: { ...current.issue, executionState: { ...current.issue.executionState, currentStageId: "later" } } })).toBe(false);
  });

  it("rechecks the same committed source at admission and claim", async () => {
    const issue: {
      id: string; companyId: string; status: string; assigneeAgentId: string;
      executionState: { status: string; currentStageId: string; lastDecisionId: string;
        returnAssignee: { type: string; agentId: string } };
    } = structuredClone(current.issue);
    const decision = structuredClone(current.decision);
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({ limit: async () => table === issues ? [issue] : table === issueExecutionDecisions ? [decision] : [] }),
        }),
      }),
    } as unknown as Db;
    const identity = {
      companyId: current.companyId, issueId: current.issueId,
      agentId: current.agentId, decisionId: current.decisionId,
    };
    expect(await isAuthorizedQaDecisionWake(db, identity)).toBe(true);
    const committedId = "11111111-1111-4111-8111-111111111111";
    expect(qaDecisionIdFromWakeKey(qaDecisionWakeKey(committedId))).toBe(committedId);
    // A later review decision makes the queued wake stale before claim.
    issue.executionState.lastDecisionId = "new-decision";
    expect(await isAuthorizedQaDecisionWake(db, identity)).toBe(false);
  });
});
