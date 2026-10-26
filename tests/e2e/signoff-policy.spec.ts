import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Signoff execution policy flow.
 *
 * Validates the full signoff lifecycle through the API and UI:
 *   1. Create a company with executor + reviewer + approver agents
 *   2. Create an issue with a two-stage execution policy (review → approval)
 *   3. Executor marks done → issue routes to reviewer (in_review)
 *   4. Reviewer approves → issue routes to approver
 *   5. Approver approves → execution completes, issue marked done
 *   6. Verify "changes requested" flow returns to executor
 *
 * Requires local_trusted deployment mode (set in playwright.config.ts webServer env).
 *
 * Agent auth flow:
 *   - Board request (local_trusted auto-auth) handles setup/teardown.
 *   - Agent-specific actions use API keys + heartbeat run IDs.
 *   - Reviewers/approvers invoke heartbeat runs (gets run IDs) then PATCH
 *     directly without checkout (checkout would force in_progress, breaking
 *     the in_review state the signoff policy requires).
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = `E2E-Signoff-${Date.now()}`;

interface AgentAuth {
  agentId: string;
  token: string;
  keyId: string;
  request: APIRequestContext;
}

interface TestContext {
  companyId: string;
  companyPrefix: string;
  executor: AgentAuth;
  reviewer: AgentAuth;
  approver: AgentAuth;
  boardRequest: APIRequestContext;
  issueIds: string[];
}

interface IssueRunLockState {
  companyId: string;
  status: string | null;
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  currentStageType: string | null;
}

function diagnosticRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// Failure output may reach CI logs. Only fixed-shape identifiers, status codes,
// timestamps, and issue-ID comparisons may cross this boundary.
function diagnosticId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value : "<non-uuid>";
}

const DIAGNOSTIC_CODES = new Set([
  "todo", "in_progress", "in_review", "done", "blocked", "cancelled",
  "review", "approval", "queued", "running", "succeeded", "failed",
  "timed_out", "scheduled_retry", "claimed", "coalesced", "skipped",
  "completed", "deferred_issue_execution", "legacy", "native",
  "timer", "assignment", "on_demand", "automation", "other",
  "issue_execution_deferred", "chat_task_completed", "issue_assigned",
  "issue_blockers_resolved", "issue_commented", "issue_comment_mentioned",
  "issue_dependencies_blocked", "issue_tree_hold_active", "missing_issue_comment",
  "process_lost_retry", "run_liveness_continuation", "heartbeat.disabled",
  "heartbeat.timer.no_actionable_work", "heartbeat.wakeOnDemand.disabled",
]);

function diagnosticCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return DIAGNOSTIC_CODES.has(value) ? value : "<other>";
}

function diagnosticTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function issueRelation(value: unknown, issueId: string): "same" | "different" | "missing" {
  return typeof value !== "string" ? "missing" : value === issueId ? "same" : "different";
}

function projectRunCandidate(lookupId: string, status: number, body: unknown, issueId: string) {
  const run = diagnosticRecord(body);
  const context = diagnosticRecord(run?.contextSnapshot);
  const paperclipIssue = diagnosticRecord(context?.paperclipIssue);
  return {
    lookupId: diagnosticId(lookupId),
    responseStatus: status,
    id: diagnosticId(run?.id),
    agentId: diagnosticId(run?.agentId),
    status: diagnosticCode(run?.status),
    runtimeMode: diagnosticCode(run?.runtimeMode),
    wakeupRequestId: diagnosticId(run?.wakeupRequestId),
    nativeIssueId: diagnosticId(run?.nativeIssueId),
    nativeIssueRelation: issueRelation(run?.nativeIssueId, issueId),
    contextIssueRelation: issueRelation(context?.issueId, issueId),
    contextTaskRelation: issueRelation(context?.taskId, issueId),
    contextTaskKeyRelation: issueRelation(context?.taskKey, issueId),
    contextPaperclipIssueRelation: issueRelation(paperclipIssue?.id, issueId),
    contextWakeReason: diagnosticCode(context?.wakeReason),
    createdAt: diagnosticTime(run?.createdAt),
  };
}

function projectIssueRunLock(lock: IssueRunLockState | null) {
  return lock && {
    status: diagnosticCode(lock.status),
    assigneeAgentId: diagnosticId(lock.assigneeAgentId),
    executionRunId: diagnosticId(lock.executionRunId),
    checkoutRunId: diagnosticId(lock.checkoutRunId),
    currentStageType: diagnosticCode(lock.currentStageType),
  };
}

/** Create an authenticated APIRequestContext for an agent (token set, no run ID yet). */
async function createAgentRequest(token: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

/** Invoke a heartbeat run for an agent, returning the run ID. */
async function invokeHeartbeat(
  board: APIRequestContext,
  agentId: string,
  issueId: string,
): Promise<string> {
  const invokeStartedAt = Date.now();
  const res = await board.post(`${BASE_URL}/api/agents/${agentId}/heartbeat/invoke`, {
    data: {
      reason: "issue_assigned",
      payload: { issueId, taskId: issueId, taskKey: issueId },
    },
  });
  expect(res.ok()).toBe(true);
  const run = diagnosticRecord(await res.json());
  if (typeof run?.id === "string" && run.id.length > 0) return run.id;

  type CandidateObservation = ReturnType<typeof projectRunCandidate>;
  const observedCandidates = new Map<string, { first: CandidateObservation; latest: CandidateObservation; reads: number }>();
  const observeCandidate = (id: string, observation: CandidateObservation) => {
    const previous = observedCandidates.get(id);
    observedCandidates.set(id, {
      first: previous?.first ?? observation,
      latest: observation,
      reads: (previous?.reads ?? 0) + 1,
    });
  };
  const candidateOrigins = new Map<string, Set<string>>();
  const markCandidateOrigin = (candidate: unknown, origin: string) => {
    if (typeof candidate !== "string" || candidate.length === 0) return;
    const origins = candidateOrigins.get(candidate) ?? new Set<string>();
    origins.add(origin);
    candidateOrigins.set(candidate, origins);
  };
  const recentListStatuses = new Set<number>();
  let recentListInvalidShape = false;
  let lockAtStart: IssueRunLockState | null = null;

  // A stage transition can already be replacing the previous executor's run
  // with the participant's queued run. If the legacy invoke is skipped and
  // that run has already released the issue lock, recover it from the agent's
  // recent run receipts.
  const deadline = Date.now() + 3_000;
  do {
    const issueRunLock = await getIssueRunLockState(board, issueId);
    lockAtStart ??= issueRunLock;
    if (issueRunLock.assigneeAgentId !== agentId) {
      // Negative authorization cases intentionally invoke a non-participant.
      // Preserve the server rejection instead of waiting for a run that must
      // never be assigned to that agent.
      return issueRunLock.executionRunId ?? issueRunLock.checkoutRunId ?? "";
    }
    const candidates = new Set<string>([
      run?.executionRunId,
      issueRunLock.executionRunId,
      issueRunLock.checkoutRunId,
    ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0));
    markCandidateOrigin(run?.executionRunId, "invoke.executionRunId");
    markCandidateOrigin(issueRunLock.executionRunId, "lock.executionRunId");
    markCandidateOrigin(issueRunLock.checkoutRunId, "lock.checkoutRunId");
    const recentRunsRes = await board.get(
      `${BASE_URL}/api/companies/${issueRunLock.companyId}/heartbeat-runs?agentId=${agentId}&limit=20`,
    );
    recentListStatuses.add(recentRunsRes.status());
    if (recentRunsRes.ok()) {
      const recentRuns = await recentRunsRes.json();
      if (!Array.isArray(recentRuns)) recentListInvalidShape = true;
      for (const recentRun of Array.isArray(recentRuns) ? recentRuns : []) {
        const recentRunId = diagnosticRecord(recentRun)?.id;
        if (typeof recentRunId === "string") {
          candidates.add(recentRunId);
          markCandidateOrigin(recentRunId, "reviewer.recentRuns");
        }
      }
    }
    for (const candidate of candidates) {
      const runRes = await board.get(`${BASE_URL}/api/heartbeat-runs/${candidate}`);
      if (!runRes.ok()) {
        observeCandidate(candidate, projectRunCandidate(candidate, runRes.status(), null, issueId));
        continue;
      }
      const candidateRun = diagnosticRecord(await runRes.json());
      observeCandidate(candidate, projectRunCandidate(candidate, runRes.status(), candidateRun, issueId));
      const context = diagnosticRecord(candidateRun?.contextSnapshot);
      if (
        candidateRun?.agentId === agentId &&
        (context?.issueId === issueId || context?.taskId === issueId)
      ) {
        return candidate;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  let lockAtDeadline: IssueRunLockState | null = null;
  try { lockAtDeadline = await getIssueRunLockState(board, issueId); } catch { /* Retain the original timeout failure. */ }
  let wakeReceipt: Record<string, unknown> = { state: "unavailable", responseStatus: null };
  try {
    // This board-readable route is issue-scoped and returns a bounded,
    // redacted projection. It does not expose raw wake payload.issueId.
    const wakeRes = await board.get(`${BASE_URL}/api/issues/${issueId}/diagnostics/wakes`);
    if (wakeRes.ok()) {
      const diagnostic = diagnosticRecord(await wakeRes.json());
      const events = Array.isArray(diagnostic?.events) ? diagnostic.events : [];
      const caps = diagnosticRecord(diagnostic?.caps);
      wakeReceipt = {
        state: "read",
        responseStatus: wakeRes.status(),
        eventsShape: Array.isArray(diagnostic?.events) ? "array" : "missing_or_invalid",
        wakeRequestCount: typeof diagnostic?.wakeRequestCount === "number" ? diagnostic.wakeRequestCount : null,
        truncated: typeof diagnostic?.truncated === "boolean" ? diagnostic.truncated : null,
        maxWakeRequests: typeof caps?.maxWakeRequests === "number" ? caps.maxWakeRequests : null,
        lookbackDays: typeof caps?.lookbackDays === "number" ? caps.lookbackDays : null,
        issueScope: "route_bound",
        payloadIssueId: "not_exposed_by_route",
        events: events.flatMap((value) => {
          const event = diagnosticRecord(value);
          if (event?.kind !== "wake_request") return [];
          const requestedAt = diagnosticTime(event.requestedAt);
          if (requestedAt && Date.parse(requestedAt) < invokeStartedAt) return [];
          return [{
            agentId: diagnosticId(event.agentId),
            matchesInvokedAgent: event.agentId === agentId,
            runId: diagnosticId(event.runId),
            source: diagnosticCode(event.source),
            status: diagnosticCode(event.status),
            reason: diagnosticCode(event.reason),
            requestedAt,
            failureClass: diagnosticCode(event.failureClass),
          }];
        }),
      };
    } else wakeReceipt = { state: "http_error", responseStatus: wakeRes.status() };
  } catch { wakeReceipt = { state: "request_failed", responseStatus: null }; }

  throw new Error(`No issue-bound heartbeat run became available: ${JSON.stringify({
    invokedAgentId: diagnosticId(agentId),
    issueId: diagnosticId(issueId),
    invoke: {
      responseStatus: res.status(),
      bodyId: diagnosticId(run?.id),
      bodyStatus: diagnosticCode(run?.status),
      bodyReason: diagnosticCode(run?.reason),
      bodyExecutionRunId: diagnosticId(run?.executionRunId),
    },
    lockAtStart: projectIssueRunLock(lockAtStart),
    lockAtDeadline: projectIssueRunLock(lockAtDeadline),
    recentRunList: { responseStatuses: [...recentListStatuses], invalidShape: recentListInvalidShape },
    candidates: [...observedCandidates].map(([id, observation]) => ({
      ...observation,
      origins: [...(candidateOrigins.get(id) ?? [])],
    })),
    wakeReceipt,
  })}`);
}

async function getIssueRunLockState(board: APIRequestContext, issueId: string): Promise<IssueRunLockState> {
  const res = await board.get(`${BASE_URL}/api/issues/${issueId}`);
  expect(res.ok()).toBe(true);
  const issue = await res.json();
  return {
    companyId: issue.companyId,
    status: issue.status ?? null,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    checkoutRunId: issue.checkoutRunId ?? null,
    executionRunId: issue.executionRunId ?? null,
    currentStageType: issue.executionState?.currentStageType ?? null,
  };
}

async function retryAgentPatchWithCurrentLockOnConflict(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  failedRes: Awaited<ReturnType<APIRequestContext["patch"]>>,
  patchData: Record<string, unknown>,
  fallbackRunId: string,
) {
  if (failedRes.status() !== 409) return failedRes;
  let res = failedRes;
  for (let attempt = 0; attempt < 8 && res.status() === 409; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, 50 * 2 ** attempt)));
    const issueRunLock = await getIssueRunLockState(board, issueId);
    if (issueRunLock.assigneeAgentId !== agent.agentId) return res;

    const lockedRunId = issueRunLock.checkoutRunId ?? issueRunLock.executionRunId ?? fallbackRunId;
    res = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
      headers: { "X-Paperclip-Run-Id": lockedRunId },
      data: patchData,
    });
  }
  return res;
}

/**
 * PATCH an issue as an agent, using a freshly invoked heartbeat run.
 *
 * Invoking a heartbeat starts a background run that races this PATCH for the
 * issue's run-lock: the background run may check the issue out (flipping it to
 * `in_progress` under its own run id) a moment before — or after — this PATCH
 * lands, and the server answers the loser with a 409 ("Issue is checked out by
 * another agent"). With `retries: 0` / `workers: 1` a single transient 409
 * fails the whole shard, so we retry a run-lock 409 under the issue's *current*
 * lock, bounded by escalating backoff to cover the race window.
 *
 * The retry is intentionally narrow so the suite's negative paths keep failing
 * for the right reason:
 *   - It only re-PATCHes while the issue is still assigned to the acting agent,
 *     so a non-participant's genuine 409/403 rejection is returned untouched.
 *   - It re-PATCHes under the winning run id (or the invoked run id once the
 *     background run has released its lock), so a real validation error such as
 *     the missing-comment 400 surfaces instead of a masking transient 409.
 */
async function agentPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  data: Record<string, unknown>,
  {
    maxAttempts = 8,
    backoffMs = 50,
    maxBackoffMs = 500,
  }: { maxAttempts?: number; backoffMs?: number; maxBackoffMs?: number } = {},
) {
  const runId = await invokeHeartbeat(board, agent.agentId, issueId);
  const patchWith = (patchRunId: string) =>
    agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
      headers: { "X-Paperclip-Run-Id": patchRunId },
      data,
    });

  let res = await patchWith(runId);
  for (let attempt = 1; attempt < maxAttempts && res.status() === 409; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - 1))));
    const issueRunLock = await getIssueRunLockState(board, issueId);
    // A 409 on an issue no longer assigned to us is a genuine rejection, not a
    // run-lock race — leave it for the caller to assert on.
    if (issueRunLock.assigneeAgentId !== agent.agentId) break;
    const retryRunId = issueRunLock.checkoutRunId ?? issueRunLock.executionRunId ?? runId;
    res = await patchWith(retryRunId);
  }
  return res;
}

/** Checkout an issue as an agent, then PATCH it. Used for executor mark-done. */
async function agentCheckoutAndPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  expectedStatuses: string[],
  patchData: Record<string, unknown>,
) {
  const runId = await invokeHeartbeat(board, agent.agentId, issueId);
  const directPatchRes = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: patchData,
  });
  if (directPatchRes.ok()) return directPatchRes;

  // Checkout (sets executionRunId so PATCH is allowed)
  const checkoutRes = await agent.request.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: { agentId: agent.agentId, expectedStatuses },
  });
  if (!checkoutRes.ok()) {
    if (checkoutRes.status() === 409) {
      const res = await retryAgentPatchWithCurrentLockOnConflict(
        board,
        agent,
        issueId,
        checkoutRes,
        patchData,
        runId,
      );
      if (res.ok()) {
        return res;
      }
    }
    // If agent checkout fails (e.g. run expired), fall back to board checkout
    // then PATCH with the agent's identity
    const boardCheckout = await board.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
      data: { agentId: agent.agentId, expectedStatuses },
    });
    if (!boardCheckout.ok()) {
      throw new Error(`Board checkout failed: ${await boardCheckout.text()}`);
    }
    // Board PATCH (executor mark-done triggers signoff regardless of actor)
    const res = await board.patch(`${BASE_URL}/api/issues/${issueId}`, {
      data: patchData,
    });
    return res;
  }
  // PATCH with agent identity
  const res = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: patchData,
  });
  const retried = await retryAgentPatchWithCurrentLockOnConflict(
    board,
    agent,
    issueId,
    res,
    patchData,
    runId,
  );
  if (retried.status() !== 409) return retried;

  // A no-op process adapter can replace and release the executor's lock faster
  // than an agent-authored retry can adopt it. This flow already permits a
  // board fallback when checkout loses that race; apply the same fallback when
  // the post-checkout PATCH exhausts its bounded lock retries.
  const issueRunLock = await getIssueRunLockState(board, issueId);
  if (issueRunLock.assigneeAgentId !== agent.agentId) return retried;
  return board.patch(`${BASE_URL}/api/issues/${issueId}`, { data: patchData });
}

async function setupCompany(boardRequest: APIRequestContext): Promise<TestContext> {
  // Verify server is in local_trusted mode
  const healthRes = await boardRequest.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json();
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(
      `Signoff e2e tests require local_trusted deployment mode, ` +
        `but server is in "${health.deploymentMode}" mode. ` +
        `Set PAPERCLIP_DEPLOYMENT_MODE=local_trusted or use the webServer config.`,
    );
  }

  // Create company
  const companyRes = await boardRequest.post(`${BASE_URL}/api/companies`, {
    data: { name: COMPANY_NAME },
  });
  if (!companyRes.ok()) {
    const errBody = await companyRes.text();
    throw new Error(`POST /api/companies → ${companyRes.status()}: ${errBody}`);
  }
  const company = await companyRes.json();
  const companyId = company.id;
  const companyPrefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";

  // Helper: hire/approve agent + API key + request context
  async function createAgent(name: string, role: string, title: string): Promise<AgentAuth> {
    const agentRes = await boardRequest.post(`${BASE_URL}/api/companies/${companyId}/agent-hires`, {
      data: {
        name,
        role,
        title,
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('done\\n')"],
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const hire = await agentRes.json();
    const agent = hire.agent;
    if (hire.approval) {
      const approvalRes = await boardRequest.post(`${BASE_URL}/api/approvals/${hire.approval.id}/approve`, {
        data: { decisionNote: "Approved for signoff e2e setup." },
      });
      expect(approvalRes.ok()).toBe(true);
    }

    const keyRes = await boardRequest.post(`${BASE_URL}/api/agents/${agent.id}/keys`, {
      data: { name: `e2e-${name.toLowerCase()}` },
    });
    expect(keyRes.ok()).toBe(true);
    const keyData = await keyRes.json();

    return {
      agentId: agent.id,
      token: keyData.token,
      keyId: keyData.id,
      request: await createAgentRequest(keyData.token),
    };
  }

  const executor = await createAgent("Executor", "engineer", "Software Engineer");
  const reviewer = await createAgent("Reviewer", "qa", "QA Engineer");
  const approver = await createAgent("Approver", "cto", "CTO");

  return {
    companyId,
    companyPrefix,
    executor,
    reviewer,
    approver,
    boardRequest,
    issueIds: [],
  };
}

async function createIssueWithPolicy(ctx: TestContext, title: string, stages?: unknown[]) {
  const defaultStages = [
    { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    { type: "approval", participants: [{ type: "agent", agentId: ctx.approver.agentId }] },
  ];
  const res = await ctx.boardRequest.post(`${BASE_URL}/api/companies/${ctx.companyId}/issues`, {
    data: {
      title,
      status: "in_progress",
      assigneeAgentId: ctx.executor.agentId,
      executionPolicy: { stages: stages ?? defaultStages },
    },
  });
  expect(res.ok()).toBe(true);
  const issue = await res.json();
  ctx.issueIds.push(issue.id);
  return issue;
}

test.describe("Signoff execution policy", () => {
  let ctx: TestContext;

  test.beforeAll(async () => {
    const boardRequest = await pwRequest.newContext({ baseURL: BASE_URL });
    ctx = await setupCompany(boardRequest);
  });

  test.afterAll(async () => {
    if (!ctx) return;
    const board = ctx.boardRequest;

    // Dispose agent request contexts
    for (const agent of [ctx.executor, ctx.reviewer, ctx.approver]) {
      await agent.request.dispose();
    }

    // Clean up issues, keys, agents, company (best-effort)
    for (const issueId of ctx.issueIds) {
      await board.patch(`${BASE_URL}/api/issues/${issueId}`, {
        data: { status: "cancelled", comment: "E2E test cleanup." },
      }).catch(() => {});
    }
    for (const agent of [ctx.executor, ctx.reviewer, ctx.approver]) {
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}/keys/${agent.keyId}`).catch(() => {});
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}`).catch(() => {});
    }
    await board.delete(`${BASE_URL}/api/companies/${ctx.companyId}`).catch(() => {});
    await board.dispose();
  });

  test("happy path: executor → review → approval → done", async ({ page }) => {
    const issue = await createIssueWithPolicy(ctx, "Signoff happy path");
    const issueId = issue.id;

    // Verify policy was saved
    expect(issue.executionPolicy).toBeTruthy();
    expect(issue.executionPolicy.stages).toHaveLength(2);
    expect(issue.executionPolicy.stages[0].type).toBe("review");
    expect(issue.executionPolicy.stages[1].type).toBe("approval");

    // Step 1: Executor marks done → should route to reviewer
    const step1Res = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Implemented the feature, ready for review." },
    );
    expect(step1Res.ok()).toBe(true);
    const step1Issue = await step1Res.json();

    expect(step1Issue.status).toBe("in_review");
    expect(step1Issue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(step1Issue.executionState).toBeTruthy();
    expect(step1Issue.executionState.status).toBe("pending");
    expect(step1Issue.executionState.currentStageType).toBe("review");
    expect(step1Issue.executionState.returnAssignee).toMatchObject({
      type: "agent",
      agentId: ctx.executor.agentId,
    });

    // Step 2: Navigate to issue in UI and verify execution label
    await page.goto(`/${ctx.companyPrefix}/issues/${issue.identifier}`);
    await expect(page.locator("text=Review pending")).toBeVisible({ timeout: 10_000 });

    // Step 3: Reviewer approves → should route to approver
    const step3Res = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "done", comment: "QA signoff complete. Looks good." },
    );
    expect(step3Res.ok()).toBe(true);
    const step3Issue = await step3Res.json();

    expect(step3Issue.status).toBe("in_review");
    expect(step3Issue.assigneeAgentId).toBe(ctx.approver.agentId);
    expect(step3Issue.executionState.status).toBe("pending");
    expect(step3Issue.executionState.currentStageType).toBe("approval");
    expect(step3Issue.executionState.completedStageIds).toHaveLength(1);

    // Step 4: Verify UI shows approval pending
    await page.reload();
    await expect(page.locator("text=Approval pending")).toBeVisible({ timeout: 10_000 });

    // Step 5: Approver approves → should complete
    const step5Res = await agentPatch(
      ctx.boardRequest, ctx.approver, issueId,
      { status: "done", comment: "Approved. Ship it." },
    );
    expect(step5Res.ok()).toBe(true);
    const step5Issue = await step5Res.json();

    expect(step5Issue.status).toBe("done");
    expect(step5Issue.executionState.status).toBe("completed");
    expect(step5Issue.executionState.completedStageIds).toHaveLength(2);
    expect(step5Issue.executionState.lastDecisionOutcome).toBe("approved");
  });

  test("changes requested: reviewer bounces back to executor", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff changes requested");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Ready for review." },
    );
    expect(doneRes.ok()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

    // Reviewer requests changes → returns to executor
    const changesRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "in_progress", comment: "Needs another pass on edge cases." },
    );
    expect(changesRes.ok()).toBe(true);
    const changesIssue = await changesRes.json();

    expect(changesIssue.status).toBe("in_progress");
    expect(changesIssue.assigneeAgentId).toBe(ctx.executor.agentId);
    expect(changesIssue.executionState.status).toBe("changes_requested");
    expect(changesIssue.executionState.lastDecisionOutcome).toBe("changes_requested");

    // Executor re-submits → goes back to reviewer (same stage)
    const resubmitRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Fixed the edge cases." },
    );
    expect(resubmitRes.ok()).toBe(true);
    const resubmitIssue = await resubmitRes.json();

    expect(resubmitIssue.status).toBe("in_review");
    expect(resubmitIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(resubmitIssue.executionState.status).toBe("pending");
    expect(resubmitIssue.executionState.currentStageType).toBe("review");
  });

  test("comment required: approval without comment fails", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff comment required");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Done." },
    );
    expect(doneRes.ok()).toBe(true);
    const doneIssue = await doneRes.json();
    expect(doneIssue.status).toBe("in_review");
    expect(doneIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);

    // Reviewer tries to approve without comment → should fail
    const noCommentRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "done" },
    );
    expect(noCommentRes.ok()).toBe(false);
    const errorBody = await noCommentRes.json();
    expect(JSON.stringify(errorBody)).toContain("comment");
  });

  test("non-participant cannot advance stage", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff access control");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Done." },
    );
    expect(doneRes.ok()).toBe(true);

    // Verify issue is in_review with reviewer
    const issueRes = await ctx.boardRequest.get(`${BASE_URL}/api/issues/${issueId}`);
    const inReviewIssue = await issueRes.json();
    expect(inReviewIssue.status).toBe("in_review");
    expect(inReviewIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(inReviewIssue.executionState.currentStageType).toBe("review");

    // Non-participant (approver at this stage) tries to advance → should be rejected
    const advanceRes = await agentPatch(
      ctx.boardRequest, ctx.approver, issueId,
      { status: "done", comment: "I'm the approver, not the reviewer." },
    );
    expect(advanceRes.ok()).toBe(false);
    expect(advanceRes.status()).toBeGreaterThanOrEqual(400);
  });

  test("review-only policy: reviewer approval completes execution", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff review-only", [
      { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    ]);

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issue.id, ["in_progress"],
      { status: "done", comment: "Ready for review." },
    );
    expect(doneRes.ok()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

    // Reviewer approves → should complete immediately (no approval stage)
    const approveRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issue.id,
      { status: "done", comment: "LGTM." },
    );
    expect(approveRes.ok()).toBe(true);
    const doneIssue = await approveRes.json();
    expect(doneIssue.status).toBe("done");
    expect(doneIssue.executionState.status).toBe("completed");
    expect(doneIssue.executionState.completedStageIds).toHaveLength(1);
  });
});
