import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

describe("conditional board review start", () => {
 let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
 beforeAll(async () => { server = await startRunnerApiTestServer({ deploymentMode: "local_trusted" }); }, 90_000);
 afterAll(async () => { await server?.close(); });
 async function fixture(active = false) {
  const f = await server.fixture({ disableWakeOnDemand: true });
  const reviewer = randomUUID();
  await server.db.insert(agents).values({ id: reviewer, companyId: f.companyId, name: "Independent reviewer", adapterType: "paperclip_runner", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } }, status: "idle" });
  if (!active) await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
  const [read] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
  const stageId = randomUUID();
  const body = { status: "in_review", executionPolicy: { stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: reviewer }] }] }, comment: "Review the exact successful execution.", boardReviewExpected: { stageId, reviewerAgentId: reviewer, revision: read!.revision, statusVersion: read!.statusVersion } };
  const patch = (extra = {}) => fetch(`${server.apiUrl}/api/issues/${f.issueId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify((() => { const request = { ...body, ...extra }; if (process.env.BOARD_REVIEW_OLD_CONTRACT === "1") { const expected = request.boardReviewExpected as Record<string, unknown>; delete expected.stageId; delete expected.reviewerAgentId; } return request; })()) });
  return { f, reviewer, read: read!, body, patch };
 }
 it("starts exactly one pending stage and preserves the completed execution", async () => {
  const { f, reviewer, patch } = await fixture();
  const r = await patch(); expect(r.status).toBe(200);
  const result = await r.json(); expect(result.status).toBe("in_review"); expect(result.assigneeAgentId).toBe(reviewer); expect(result.executionState.status).toBe("pending");
  expect((await patch()).status).toBe(409);
  const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)); expect(run!.status).toBe("succeeded");
  expect(await server.db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.body, "Review the exact successful execution.")))).toHaveLength(1);
 });
 it("refuses active execution without cancelling it", async () => {
  const { f, patch } = await fixture(true); expect((await patch()).status).toBe(409);
  const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)); expect(run!.status).toBe("running");
  const [issue] = await server.db.select().from(issues).where(eq(issues.id, f.issueId)); expect(issue!.status).toBe("in_progress"); expect(issue!.executionPolicy).toBeNull();
 });
 it("refuses a requirement changed before row lock and records no review comment", async () => {
  const { f, patch } = await fixture();
  await server.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, body: "New requirement" });
  expect((await patch()).status).toBe(409);
  const [issue] = await server.db.select().from(issues).where(eq(issues.id, f.issueId)); expect(issue!.status).toBe("in_progress"); expect(issue!.executionPolicy).toBeNull();
 });
 it("checks the revision again after waiting for the issue row lock", async () => {
  const { f, patch } = await fixture(); let pending!: Promise<Response>;
  await server.db.transaction(async tx => {
   await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
   pending = patch();
   await expect.poll(async () => {
    const blocked = await server.db.execute(sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query NOT LIKE '%pg_stat_activity%'`);
    return Number(blocked[0]?.count ?? 0);
   }, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
   await tx.update(issues).set({ description: "Concurrent requirement arrived" }).where(eq(issues.id, f.issueId));
  });
  expect((await pending).status).toBe(409);
  const [issue] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
  expect(issue!.description).toBe("Concurrent requirement arrived"); expect(issue!.status).toBe("in_progress"); expect(issue!.executionPolicy).toBeNull();
 }, 30_000);
 it("refuses execution that starts while the review request waits for the row lock", async () => {
  const { f, patch } = await fixture(); let pending!: Promise<Response>; const concurrentRun = randomUUID();
  await server.db.transaction(async tx => {
   await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update"); pending = patch();
   await expect.poll(async () => {
    const blocked = await server.db.execute(sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query NOT LIKE '%pg_stat_activity%'`);
    return Number(blocked[0]?.count ?? 0);
   }, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
   await tx.insert(heartbeatRuns).values({ id: concurrentRun, companyId: f.companyId, agentId: f.agentId, status: "queued", nativeIssueId: f.issueId, invocationSource: "assignment", triggerDetail: "system" });
  });
  expect((await pending).status).toBe(409);
  const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, concurrentRun)); expect(run!.status).toBe("queued");
  const [issue] = await server.db.select().from(issues).where(eq(issues.id, f.issueId)); expect(issue!.status).toBe("in_progress"); expect(issue!.executionPolicy).toBeNull();
 }, 30_000);
 it("rejects a dropped empty review stage instead of leaving an orphan in_review issue", async () => {
  const { f, body, patch } = await fixture();
  expect((await patch({ executionPolicy: { stages: [{ ...body.executionPolicy.stages[0], participants: [] }] } })).status).toBe(409);
  const [issue] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
  expect(issue!.status).toBe("in_progress"); expect(issue!.executionPolicy).toBeNull(); expect(issue!.executionState).toBeNull();
  expect(await server.db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.body, body.comment)))).toHaveLength(0);
 });
 it("rolls back review start when the comment idempotency key has a different body", async () => {
  const { f, body, patch } = await fixture(); const requestId = randomUUID();
  const prior = await fetch(`${server.apiUrl}/api/issues/${f.issueId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ comment: "Existing different comment", commentClientRequestId: requestId }) });
  expect(prior.status).toBe(200);
  const [read] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
  expect((await patch({ commentClientRequestId: requestId, boardReviewExpected: { ...body.boardReviewExpected, revision: read!.revision, statusVersion: read!.statusVersion } })).status).toBe(409);
  const [issue] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
  expect(issue!.status).toBe("in_progress"); expect(issue!.executionPolicy).toBeNull(); expect(issue!.executionState).toBeNull(); expect(issue!.assigneeAgentId).toBe(f.agentId);
  expect(await server.db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.body, body.comment)))).toHaveLength(0);
 });
 it("resumes the same blocked pending review with a version-bound transaction", async () => {
  const { f, body, patch } = await fixture(); expect((await patch()).status).toBe(200);
  await server.db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
  const [blocked] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
  const response=await fetch(`${server.apiUrl}/api/issues/${f.issueId}`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"in_review",comment:"Runtime closure fixed; resume independent QA.",boardReviewExpected:{...body.boardReviewExpected,resume:true,revision:blocked!.revision,statusVersion:blocked!.statusVersion}})});
  expect(response.status).toBe(200);const updated=await response.json();expect(updated.status).toBe("in_review");expect(updated.executionState).toEqual(blocked!.executionState);expect(updated.assigneeAgentId).toBe(blocked!.assigneeAgentId);
  expect(await server.db.select().from(issueComments).where(and(eq(issueComments.issueId,f.issueId),eq(issueComments.body,"Runtime closure fixed; resume independent QA.")))).toHaveLength(1);
 });
 it("refuses blocked review resume with another reviewer or changed version", async () => {
  const { f, body, patch } = await fixture();expect((await patch()).status).toBe(200);await server.db.update(issues).set({status:"blocked"}).where(eq(issues.id,f.issueId));
  const [blocked]=await server.db.select().from(issues).where(eq(issues.id,f.issueId));
  for(const expectation of [{...body.boardReviewExpected,reviewerAgentId:randomUUID(),resume:true,revision:blocked!.revision,statusVersion:blocked!.statusVersion},{...body.boardReviewExpected,resume:true,revision:blocked!.revision-1,statusVersion:blocked!.statusVersion}]){
   const response=await fetch(`${server.apiUrl}/api/issues/${f.issueId}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"in_review",comment:"Stale resume must fail",boardReviewExpected:expectation})});expect(response.status).toBe(409);
  }
  const [after]=await server.db.select().from(issues).where(eq(issues.id,f.issueId));expect(after!.status).toBe("blocked");expect(after!.executionState).toEqual(blocked!.executionState);
 });
 it("does not allow arbitrary edits through the review precondition", async () => {
  const { patch } = await fixture(); expect((await patch({ description: "Unreviewed replacement" })).status).toBe(403);
 });
 async function changedFixture() {
  const x=await fixture();expect((await x.patch()).status).toBe(200);
  const [pending]=await server.db.select().from(issues).where(eq(issues.id,x.f.issueId));
  const state={...pending!.executionState!,status:"changes_requested" as const,lastDecisionId:randomUUID(),lastDecisionOutcome:"changes_requested" as const,changesRequestedCount:1};
  await server.db.update(issues).set({status:"in_progress",assigneeAgentId:x.f.agentId,executionState:state}).where(eq(issues.id,x.f.issueId));
  const [read]=await server.db.select().from(issues).where(eq(issues.id,x.f.issueId));
  const expected={...x.body.boardReviewExpected,resubmit:true,lastDecisionId:state.lastDecisionId,workerAgentId:x.f.agentId,changesRequestedCount:1,revision:read!.revision,statusVersion:read!.statusVersion};
  const send=(extra={})=>fetch(`${server.apiUrl}/api/issues/${x.f.issueId}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"in_review",comment:"Primary evidence added; resubmit same QA decision.",boardReviewExpected:{...expected,...extra}})});
  return {...x,read:read!,expected,send};
 }
 it("resubmits the same change request with decision-bound CAS and one transactional comment",async()=>{
  const {f,reviewer,expected,send}=await changedFixture();const r=await send();expect(r.status).toBe(200);
  const updated=await r.json();expect(updated.status).toBe("in_review");expect(updated.assigneeAgentId).toBe(reviewer);expect(updated.executionState.status).toBe("pending");expect(updated.executionState.currentStageId).toBe(expected.stageId);expect(updated.executionState.lastDecisionId).toBe(expected.lastDecisionId);expect(updated.executionState.changesRequestedCount).toBe(1);
  expect((await send()).status).toBe(409);expect(await server.db.select().from(issueComments).where(and(eq(issueComments.issueId,f.issueId),eq(issueComments.body,"Primary evidence added; resubmit same QA decision.")))).toHaveLength(1);
 });
 it("rejects stale revision, another decision, reviewer, worker or review round without side effects",async()=>{
  const {f,read,send}=await changedFixture();for(const extra of [{revision:read.revision-1},{lastDecisionId:randomUUID()},{workerAgentId:randomUUID()},{reviewerAgentId:randomUUID()},{changesRequestedCount:2}])expect((await send(extra)).status).toBe(409);
  const [after]=await server.db.select().from(issues).where(eq(issues.id,f.issueId));expect(after!.status).toBe("in_progress");expect(after!.executionState).toEqual(read.executionState);expect(await server.db.select().from(issueComments).where(and(eq(issueComments.issueId,f.issueId),eq(issueComments.body,"Primary evidence added; resubmit same QA decision.")))).toHaveLength(0);
 });
 it("refuses active execution on resubmission without cancelling the Run",async()=>{
  const {f,send}=await changedFixture();await server.db.update(heartbeatRuns).set({status:"running"}).where(eq(heartbeatRuns.id,f.runId));expect((await send()).status).toBe(409);const [run]=await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));expect(run!.status).toBe("running");
 });
 it("rechecks the decision after waiting for the row lock",async()=>{
  const {f,read,send}=await changedFixture();let pending!:Promise<Response>;
  await server.db.transaction(async tx=>{await tx.select({id:issues.id}).from(issues).where(eq(issues.id,f.issueId)).for("update");pending=send();await expect.poll(async()=>{const rows=await server.db.execute(sql<{count:string}>`SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query NOT LIKE '%pg_stat_activity%'`);return Number(rows[0]?.count??0);},{timeout:15000}).toBeGreaterThanOrEqual(1);await tx.update(issues).set({executionState:{...read.executionState!,lastDecisionId:randomUUID()}}).where(eq(issues.id,f.issueId));});expect((await pending).status).toBe(409);
 },30000);

});
