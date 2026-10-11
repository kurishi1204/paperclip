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
  const body = { status: "in_review", executionPolicy: { stages: [{ id: randomUUID(), type: "review", participants: [{ type: "agent", agentId: reviewer }] }] }, comment: "Review the exact successful execution.", boardReviewExpected: { revision: read!.revision, statusVersion: read!.statusVersion } };
  const patch = (extra = {}) => fetch(`${server.apiUrl}/api/issues/${f.issueId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, ...extra }) });
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
 it("does not allow arbitrary edits through the review precondition", async () => {
  const { patch } = await fixture(); expect((await patch({ description: "Unreviewed replacement" })).status).toBe(403);
 });
});
