import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { buildHermesChildEnv } from "../../../packages/adapters/hermes/src/server/safe-runtime.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "hermes_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "hermes_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));
vi.mock("../services/git-credentials.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/git-credentials.js")>(),
  resolveManagedGitHubIdentitySelection: async () => ({ configured: true, connections: [] }),
}));
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("bounded Hermes real heartbeat environment", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-bounded-hermes-env");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  }, 20_000);
  afterAll(async () => { await db.$client.end(); await stopDb?.(); });
  afterEach(() => { vi.unstubAllEnvs(); execute.mockClear(); });
  it.each([true, false, undefined])("does not inject Git hooks when pinned bounded config is %s", async (boundedExecution) => {
    const companyId = randomUUID(), agentId = randomUUID();
    vi.stubEnv("PAPERCLIP_HERMES_BOUNDED_AGENT_ID", agentId);
    await db.insert(companies).values({ id: companyId, name: "Bounded research", issuePrefix: `T${companyId.slice(0,6).toUpperCase()}`, status: "active", defaultResponsibleUserId: "responsible-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Research", role: "general", status: "idle", adapterType: "hermes_local", adapterConfig: { boundedExecution, env: { HERMES_HOME: "/safe/research" } }, runtimeConfig: {}, permissions: {} });
    execute.mockImplementation(async (context) => {
      const env = buildHermesChildEnv(context.config.env, true, { PAPERCLIP_HERMES_BOUNDED_HOME: "/safe/research" }, process.platform, false);
      expect(env.HERMES_HOME).toBe("/safe/research");
      expect(env.BASH_ENV).toBeUndefined();
      expect(env.ENV).toBeUndefined();
      expect(env.PAPERCLIP_GITHUB_BROKER_TOKEN).toBeUndefined();
      return { exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test" };
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: {} });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => { const latest = await heartbeat.getRun(run!.id); expect(latest?.status, latest?.error ?? undefined).toBe("succeeded"); }, { timeout: 10_000 });
    expect(execute).toHaveBeenCalledOnce();
    expect(() => buildHermesChildEnv({ HERMES_HOME: "/safe/research", BASH_ENV: "/hostile" }, true, { PAPERCLIP_HERMES_BOUNDED_HOME: "/safe/research" }, process.platform, false)).toThrow("BASH_ENV is not allowed");
  });
});
