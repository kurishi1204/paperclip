import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, IssueComment } from "@paperclipai/plugin-sdk";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  assets,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issues,
  pluginManagedResources,
  pluginDatabaseNamespaces,
  pluginMigrations,
  plugins,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { derivePluginDatabaseNamespace, pluginDatabaseService } from "../services/plugin-database.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import wikiManifest, { WIKI_ROOT_FOLDER_KEY } from "../../../packages/plugins/plugin-llm-wiki/src/manifest.js";
import { issueService } from "../services/issues.js";
import { logActivity, type ActivityPublication } from "../services/activity-log.js";
import { createPaperclipDistillationRun } from "../../../packages/plugins/plugin-llm-wiki/src/wiki/core.js";
import { captureOwnerCommentRaw, readOwnerCommentRaw } from "../../../packages/plugins/plugin-llm-wiki/src/wiki/owner-comment-raw.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin orchestration API tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// This new SQL receipt is a required CI acceptance test. Keep the older suite's
// local unsupported-host skip policy, but fail CI rather than report zero SQL
// assertions as a successful run when the embedded engine cannot start.
if (process.env.CI && process.env.CI !== "false" && !embeddedPostgresSupport.supported) {
  it("requires embedded PostgreSQL for the owner comment raw SQL contract in CI", () => {
    throw new Error(`Owner comment raw SQL contract did not run: ${embeddedPostgresSupport.reason ?? "embedded PostgreSQL unsupported"}`);
  });
}

describeEmbeddedPostgres("plugin orchestration APIs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-orchestration-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  function isHeartbeatRunDependentFkError(error: unknown) {
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    return (
      message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk")
      || message.includes("activity_log_run_id_heartbeat_runs_id_fk")
    );
  }

  // A real (fire-and-forget) heartbeat run may still be executing in the
  // background when a test's own createComment-triggered wakeup completes —
  // retry deletion so that race doesn't fail cleanup with an FK violation.
  async function deleteHeartbeatRunsWithDependents() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.delete(heartbeatRuns);
        return;
      } catch (error) {
        if (!isHeartbeatRunDependentFkError(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  afterEach(async () => {
    // Await every in-flight background heartbeat run to quiescence before the
    // deletes below. A createComment-triggered wakeup dispatches its run
    // fire-and-forget (void heartbeat.wakeup(...)), so a run or wakeup can still
    // write heartbeat_runs and issues rows when teardown starts and would race
    // the deletes. The heartbeat service tracks in-flight run and wakeup
    // promises in module state shared across service instances, so a fresh
    // instance here drains the runs the per-test host services dispatched.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
    // Installations are recreated per test. Removing their ledger rows alone
    // leaves SQL objects behind and makes the next real migration collide.
    // Enumerate registered namespaces in this isolated test database before
    // deleting the installations that own them.
    const namespaces = await db.select().from(pluginDatabaseNamespaces);
    for (const { namespaceName } of namespaces) {
      if (!/^plugin_[a-z0-9_]+$/.test(namespaceName)) {
        throw new Error("Unexpected plugin test namespace");
      }
      await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(namespaceName)} CASCADE`);
    }
    await db.delete(pluginMigrations);
    await db.delete(pluginDatabaseNamespaces);
    await db.delete(costEvents);
    await deleteHeartbeatRunsWithDependents();
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(pluginManagedResources);
    await db.delete(projects);
    await db.delete(plugins);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function makeLocalRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-host-folder-"));
    tempRoots.push(root);
    return root;
  }

  it("returns plugin-safe execution workspace metadata scoped to the company", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const otherCompanyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: issuePrefix(otherCompanyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspaces",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Feature workspace",
      status: "active",
      cwd: "/tmp/paperclip-feature",
      repoUrl: "https://example.com/paperclip.git",
      baseRef: "main",
      branchName: "feature/workspace",
      providerType: "git_worktree",
      providerRef: "/tmp/paperclip-feature",
      metadata: {
        providerMetadata: { sandboxId: "sandbox-1" },
        workspaceRealizationRequest: { hiddenInternal: true },
      },
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.workspace", createEventBusStub());

    await expect(services.executionWorkspaces.get({ workspaceId, companyId })).resolves.toMatchObject({
      id: workspaceId,
      companyId,
      projectId,
      projectWorkspaceId: null,
      path: "/tmp/paperclip-feature",
      cwd: "/tmp/paperclip-feature",
      repoUrl: "https://example.com/paperclip.git",
      baseRef: "main",
      branchName: "feature/workspace",
      providerType: "git_worktree",
      providerMetadata: { sandboxId: "sandbox-1" },
    });
    await expect(services.executionWorkspaces.get({ workspaceId, companyId: otherCompanyId })).resolves.toBeNull();
  });

  it("creates plugin-origin issues with full orchestration fields and audit activity", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerIssueId = randomUUID();
    const originRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: originRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: blockerIssueId },
    });
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Blocker",
      status: "todo",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-blocker`,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const issue = await services.issues.create({
      companyId,
      title: "Plugin child issue",
      status: "todo",
      assigneeAgentId: agentId,
      billingCode: "mission:alpha",
      originId: "mission-alpha",
      blockedByIssueIds: [blockerIssueId],
      actorAgentId: agentId,
      actorRunId: originRunId,
    });

    const [stored] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(stored?.originKind).toBe("plugin:paperclip.missions");
    expect(stored?.originId).toBe("mission-alpha");
    expect(stored?.billingCode).toBe("mission:alpha");
    expect(stored?.assigneeAgentId).toBe(agentId);
    expect(stored?.createdByAgentId).toBe(agentId);
    expect(stored?.originRunId).toBe(originRunId);

    const [relation] = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.issueId, blockerIssueId), eq(issueRelations.relatedIssueId, issue.id)));
    expect(relation?.type).toBe("blocks");

    const activities = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id)));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorType: "plugin",
          actorId: "plugin-record-id",
          action: "issue.created",
          agentId,
          details: expect.objectContaining({
            sourcePluginId: "plugin-record-id",
            sourcePluginKey: "paperclip.missions",
            initiatingActorType: "agent",
            initiatingActorId: agentId,
            initiatingRunId: originRunId,
          }),
        }),
      ]),
    );
  });

  it("enforces plugin origin namespaces", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const featureIssue = await services.issues.create({
      companyId,
      title: "Feature issue",
      originKind: "plugin:paperclip.missions:feature",
      originId: "mission-alpha:feature-1",
    });
    expect(featureIssue.originKind).toBe("plugin:paperclip.missions:feature");

    await expect(
      services.issues.create({
        companyId,
        title: "Spoofed issue",
        originKind: "plugin:other.plugin:feature",
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.missions");

    await expect(
      services.issues.update({
        issueId: featureIssue.id,
        companyId,
        patch: { originKind: "plugin:other.plugin:feature" },
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.missions");
  });

  it("creates plugin operation issues with the generic operation origin", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const issue = await services.issues.create({
      companyId,
      title: "Background operation",
      surfaceVisibility: "plugin_operation",
      originId: "mission-alpha:operation-1",
    });

    expect(issue.originKind).toBe("plugin:paperclip.missions:operation");
    expect(issue.originId).toBe("mission-alpha:operation-1");
  });

  it("lets bootstrap-style actions initialize required local folders from an empty root", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclipai.plugin-llm-wiki",
      packageName: "@paperclipai/plugin-llm-wiki",
      version: "0.1.0",
      manifestJson: {
        id: "paperclipai.plugin-llm-wiki",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "LLM Wiki",
        description: "Local-file LLM Wiki plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        entrypoints: { worker: "./dist/worker.js" },
        localFolders: [
          {
            folderKey: "wiki-root",
            displayName: "Wiki root",
            access: "readWrite",
            requiredDirectories: ["raw", "wiki", "wiki/concepts", ".paperclip"],
            requiredFiles: ["WIKI.md", "AGENTS.md"],
          },
        ],
      },
      status: "ready",
    });
    const root = await makeLocalRoot();
    const services = buildHostServices(
      db,
      pluginId,
      "paperclipai.plugin-llm-wiki",
      createEventBusStub(),
      undefined,
      {
        manifest: {
          id: "paperclipai.plugin-llm-wiki",
          apiVersion: 1,
          version: "0.1.0",
          displayName: "LLM Wiki",
          description: "Local-file LLM Wiki plugin",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["local.folders"],
          entrypoints: { worker: "./dist/worker.js" },
          localFolders: [
            {
              folderKey: "wiki-root",
              displayName: "Wiki root",
              access: "readWrite",
              requiredDirectories: ["raw", "wiki", "wiki/concepts", ".paperclip"],
              requiredFiles: ["WIKI.md", "AGENTS.md"],
            },
          ],
        },
      },
    );

    const configured = await services.localFolders.configure({
      companyId,
      folderKey: "wiki-root",
      path: root,
      access: "readWrite",
      requiredDirectories: ["raw", "wiki", "wiki/concepts", ".paperclip"],
      requiredFiles: ["WIKI.md", "AGENTS.md"],
    });
    expect(configured.healthy).toBe(false);
    expect(configured.missingDirectories).toEqual([]);
    expect(configured.missingFiles).toEqual(["WIKI.md", "AGENTS.md"]);

    await fs.rm(path.join(root, "raw"), { recursive: true, force: true });
    await fs.rm(path.join(root, "wiki"), { recursive: true, force: true });
    await expect(services.localFolders.readText({ companyId, folderKey: "wiki-root", relativePath: "WIKI.md" }))
      .rejects.toThrow("Local folder is not healthy");
    await services.localFolders.writeTextAtomic({
      companyId,
      folderKey: "wiki-root",
      relativePath: "WIKI.md",
      contents: "# Wiki\n",
    });
    await services.localFolders.writeTextAtomic({
      companyId,
      folderKey: "wiki-root",
      relativePath: "AGENTS.md",
      contents: "# Agents\n",
    });

    const finalStatus = await services.localFolders.status({ companyId, folderKey: "wiki-root" });
    expect(finalStatus.healthy).toBe(true);
    await expect(fs.stat(path.join(root, "raw"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(root, "wiki/concepts"))).resolves.toMatchObject({});
    await expect(fs.readFile(path.join(root, "WIKI.md"), "utf8")).resolves.toBe("# Wiki\n");
    const exclusiveFirst = await services.localFolders.createTextExclusive({
      companyId, folderKey: "wiki-root", relativePath: "raw/capture.txt", contents: "first",
    });
    const exclusiveSecond = await services.localFolders.createTextExclusive({
      companyId, folderKey: "wiki-root", relativePath: "raw/capture.txt", contents: "different",
    });
    expect([exclusiveFirst.created, exclusiveSecond.created]).toEqual([true, false]);
    expect(exclusiveFirst.status.folderKey).toBe("wiki-root");
    await expect(fs.readFile(path.join(root, "raw/capture.txt"), "utf8")).resolves.toBe("first");
    await expect(services.localFolders.createTextExclusive({
      companyId: randomUUID(), folderKey: "wiki-root", relativePath: "raw/other.txt", contents: "other",
    })).rejects.toThrow();
  });

  it("applies owner raw migration and enforces real SQL capture, readback, and tenant constraints", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId, name: "Other synthetic company", issuePrefix: issuePrefix(otherCompanyId),
      requireBoardApprovalForNewAgents: false,
    });
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId, pluginKey: wikiManifest.id, packageName: "@paperclipai/plugin-llm-wiki",
      version: wikiManifest.version, apiVersion: wikiManifest.apiVersion,
      categories: wikiManifest.categories, manifestJson: wikiManifest, status: "installed", installOrder: 1,
    });
    const repoRoot = path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
    const pluginRoot = path.join(repoRoot, "packages/plugins/plugin-llm-wiki");
    const pluginDb = pluginDatabaseService(db);
    const applied = await pluginDb.applyMigrations(pluginId, wikiManifest, pluginRoot);
    const namespace = derivePluginDatabaseNamespace(wikiManifest.id, wikiManifest.database?.namespaceSlug);
    expect(applied?.namespaceName).toBe(namespace);
    expect((await db.select().from(pluginMigrations).where(eq(pluginMigrations.pluginId, pluginId)))
      .map((row) => row.migrationKey)).toContain("004_owner_comment_raw.sql");

    const issueId = randomUUID(), commentId = randomUUID(), spaceId = randomUUID(), otherSpaceId = randomUUID();
    const owner = "synthetic-owner", body = "Synthetic owner note for SQL receipt verification.";
    const occurredAt = new Date().toISOString();
    const ingestionProfile = { version: 1, enabled: true,
      sourceScopes: [{ kind: "root_issues", issueIds: [issueId] }],
      sourceKinds: { issues: false, comments: true, documents: false, attachments: "off", workProducts: "off" },
      cursor: { maxWindowCharacters: 60000, maxCharactersPerSource: 12000, minSourceAgeMinutes: 15,
        maxWindowsPerRun: 6, staleAfterHours: 72 }, backfill: { requireManualQueue: true } };
    for (const [spaceCompanyId, id] of [[companyId, spaceId], [otherCompanyId, otherSpaceId]] as const) {
      await db.execute(sql`INSERT INTO ${sql.raw(`"${namespace}"."wiki_spaces"`)}
        (id, company_id, wiki_id, slug, display_name, settings)
        VALUES (${id}, ${spaceCompanyId}, 'default', 'owner-notes', 'Owner notes',
          ${JSON.stringify({ paperclipIngestion: ingestionProfile })}::jsonb)`);
    }
    const issue: Issue = {
      id: issueId, companyId, projectId: null, projectWorkspaceId: null, goalId: null, parentId: null,
      title: "Synthetic owner note", description: null, status: "todo", workMode: "standard",
      priority: "medium", reviewPolicy: null, assigneeAgentId: null, assigneeUserId: null,
      checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
      createdByAgentId: null, createdByUserId: null, responsibleUserId: null, issueNumber: null,
      identifier: null, requestDepth: 0, billingCode: null, assigneeAdapterOverrides: null,
      executionWorkspaceId: null, executionWorkspacePreference: null, executionWorkspaceSettings: null,
      startedAt: null, completedAt: null, cancelledAt: null, hiddenAt: null,
      createdAt: new Date(occurredAt), updatedAt: new Date(occurredAt),
    };
    const comment: IssueComment = { id: commentId, companyId, issueId, authorType: "user", authorUserId: owner,
      authorAgentId: null, onBehalfOfUserId: null, createdByRunId: null, derivedAuthorAgentId: null,
      derivedCreatedByRunId: null, derivedAuthorSource: null, deletedAt: null, sourceTrust: null,
      metadata: null, presentation: null, createdAt: new Date(occurredAt), updatedAt: new Date(occurredAt),
      body };
    const harness = createTestHarness({ manifest: wikiManifest,
      config: { ownerCommentRawCapture: { version: 1, enabled: true, spaceSlug: "owner-notes",
        ownerUserId: owner, issueIds: [issueId], maxBodyBytes: 250000, allowCompanyReaders: true,
        classification: { label: "internal", decidedByUserId: owner, decidedAt: occurredAt,
          decisionRef: "synthetic-sql-receipt" } } } });
    harness.seed({ issues: [issue], issueComments: [comment] });
    harness.ctx.db.namespace = namespace;
    harness.ctx.db.query = <T,>(statement: string, params?: unknown[]) => pluginDb.query<T>(pluginId, statement, params);
    harness.ctx.db.execute = (statement, params) => pluginDb.execute(pluginId, statement, params);
    const files = new Map<string, string>();
    let creates = 0;
    harness.ctx.localFolders.status = async () => ({ folderKey: "wiki-root", configured: true,
      path: "/synthetic/wiki", realPath: "/synthetic/wiki", access: "readWrite", readable: true,
      writable: true, requiredDirectories: [], requiredFiles: [], missingDirectories: [], missingFiles: [],
      healthy: true, problems: [], checkedAt: occurredAt });
    harness.ctx.localFolders.createTextExclusive = async (_company, _folder, relativePath, contents) => {
      if (files.has(relativePath)) return { created: false, status: {} as never };
      creates += 1;
      files.set(relativePath, contents);
      return { created: true, status: {} as never };
    };
    harness.ctx.localFolders.readText = async (_company, _folder, relativePath) => {
      const content = files.get(relativePath);
      if (content === undefined) throw new Error("synthetic missing file");
      return content;
    };
    const event = { eventId: randomUUID(), eventType: "issue.comment.created" as const,
      companyId, entityId: issueId, entityType: "issue", actorType: "user" as const,
      actorId: owner, occurredAt,
      payload: { commentId, agentId: null, runId: null, responsibleUserId: null } };
    expect(await captureOwnerCommentRaw(harness.ctx, event)).toBe("verified");
    expect(await captureOwnerCommentRaw(harness.ctx, event)).toBe("verified");
    expect(creates).toBe(1);
    expect((await readOwnerCommentRaw(harness.ctx, companyId, commentId)).source).toBe(body);
    await expect(readOwnerCommentRaw(harness.ctx, otherCompanyId, commentId))
      .rejects.toThrow("owner_comment_raw_reader_row");

    const table = sql.raw(`"${namespace}"."paperclip_owner_raw_captures"`);
    const rows = await db.execute(sql`SELECT company_id, space_id, comment_id, status,
      body_sha256, policy_sha256,
      to_char(comment_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS comment_updated_at
      FROM ${table} WHERE company_id=${companyId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ company_id: companyId, space_id: spaceId, comment_id: commentId,
      status: "verified", comment_updated_at: occurredAt });
    await expect(db.execute(sql`UPDATE ${table} SET status='invalid' WHERE company_id=${companyId}`)).rejects.toThrow();
    await expect(db.execute(sql`INSERT INTO ${table}
      (company_id,space_id,comment_id,issue_id,owner_user_id,body_sha256,comment_updated_at,raw_path,policy_sha256,status)
      SELECT company_id,space_id,comment_id,issue_id,owner_user_id,body_sha256,comment_updated_at,
        raw_path,policy_sha256,status FROM ${table} WHERE company_id=${companyId}`)).rejects.toThrow();
    await db.execute(sql`UPDATE ${table} SET status='pending' WHERE company_id=${companyId}`);
    const guardedUpdate = `UPDATE "${namespace}"."paperclip_owner_raw_captures"
      SET status='verified',updated_at=now() WHERE company_id=$1 AND space_id=$2 AND comment_id=$3
      AND body_sha256=$4 AND policy_sha256=$5 AND status='pending'`;
    const wrongPredicate = await pluginDb.execute(pluginId, guardedUpdate,
      [companyId, spaceId, commentId, "0".repeat(64), rows[0]!.policy_sha256]);
    expect(wrongPredicate.rowCount).toBe(0);
    expect((await db.execute(sql`SELECT status FROM ${table} WHERE company_id=${companyId}`))[0]?.status).toBe("pending");
    const rightPredicate = await pluginDb.execute(pluginId, guardedUpdate,
      [companyId, spaceId, commentId, rows[0]!.body_sha256, rows[0]!.policy_sha256]);
    expect(rightPredicate.rowCount).toBe(1);
    expect((await readOwnerCommentRaw(harness.ctx, companyId, commentId)).source).toBe(body);

    const otherCommentId = randomUUID();
    await db.execute(sql`INSERT INTO ${table}
      (company_id,space_id,comment_id,issue_id,owner_user_id,body_sha256,comment_updated_at,raw_path,policy_sha256,status)
      SELECT ${otherCompanyId}, ${otherSpaceId}, ${otherCommentId}, issue_id, owner_user_id,
        body_sha256,comment_updated_at,raw_path,policy_sha256,status
      FROM ${table} WHERE company_id=${companyId}`);
    expect(await db.execute(sql`SELECT comment_id FROM ${table} WHERE company_id=${otherCompanyId}`)).toHaveLength(1);
    await db.execute(sql`DELETE FROM ${sql.raw(`"${namespace}"."wiki_spaces"`)} WHERE id=${otherSpaceId}`);
    expect(await db.execute(sql`SELECT comment_id FROM ${table} WHERE company_id=${otherCompanyId}`)).toHaveLength(0);
    await db.delete(agents).where(eq(agents.id, agentId));
    expect(await db.execute(sql`SELECT comment_id FROM ${table} WHERE company_id=${companyId}`)).toHaveLength(1);
    await db.delete(companies).where(eq(companies.id, companyId));
    expect(await db.execute(sql`SELECT comment_id FROM ${table} WHERE company_id=${companyId}`)).toHaveLength(0);
  }, 90_000);

  it("captures a real board-user comment through activity, host file, and PostgreSQL receipt", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const owner = "synthetic-owner";
    const issueId = randomUUID();
    const spaceId = randomUUID();
    const body = "A synthetic owner note with no external data.";
    await db.insert(issues).values({
      id: issueId, companyId, title: "Synthetic owner capture", status: "todo", priority: "medium",
    });
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId, pluginKey: wikiManifest.id, packageName: "@paperclipai/plugin-llm-wiki",
      version: wikiManifest.version, apiVersion: wikiManifest.apiVersion,
      categories: wikiManifest.categories, manifestJson: wikiManifest, status: "installed", installOrder: 1,
    });
    const repoRoot = path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
    const pluginRoot = path.join(repoRoot, "packages/plugins/plugin-llm-wiki");
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, wikiManifest, pluginRoot);
    const namespace = derivePluginDatabaseNamespace(wikiManifest.id, wikiManifest.database?.namespaceSlug);
    const profile = { version: 1, enabled: true,
      sourceScopes: [{ kind: "root_issues", issueIds: [issueId] }],
      sourceKinds: { issues: false, comments: true, documents: false, attachments: "off", workProducts: "off" },
      cursor: { maxWindowCharacters: 60000, maxCharactersPerSource: 12000, minSourceAgeMinutes: 15,
        maxWindowsPerRun: 6, staleAfterHours: 72 }, backfill: { requireManualQueue: true } };
    await db.execute(sql`INSERT INTO ${sql.raw(`"${namespace}"."wiki_spaces"`)}
      (id, company_id, wiki_id, slug, display_name, path_prefix, settings)
      VALUES (${spaceId}, ${companyId}, 'default', 'owner-notes', 'Owner notes',
        'spaces/owner-notes',
        ${JSON.stringify({ paperclipIngestion: profile })}::jsonb)`);

    const root = await makeLocalRoot();
    const folder = wikiManifest.localFolders?.find((item) => item.folderKey === WIKI_ROOT_FOLDER_KEY);
    if (!folder) throw new Error("Wiki root declaration missing");
    for (const directory of folder.requiredDirectories ?? []) {
      await fs.mkdir(path.join(root, directory), { recursive: true });
    }
    for (const file of folder.requiredFiles ?? []) {
      const absolute = path.join(root, file);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, "# Synthetic fixture\n");
    }
    const host = buildHostServices(db, pluginId, wikiManifest.id, createEventBusStub(), undefined,
      { manifest: wikiManifest });
    const configured = await host.localFolders.configure({
      companyId, folderKey: WIKI_ROOT_FOLDER_KEY, path: root, access: "readWrite",
      requiredDirectories: folder.requiredDirectories, requiredFiles: folder.requiredFiles,
    });
    expect(configured.healthy).toBe(true);
    const comment = await issueService(db).addComment(issueId, body, { userId: owner });
    const savedComment = (await host.issues.listComments({ issueId, companyId }))
      .find((item) => item.id === comment.id);
    expect(savedComment).toMatchObject({
      id: comment.id, companyId, issueId, authorType: "user", authorUserId: owner,
      authorAgentId: null, createdByRunId: null, metadata: null, presentation: null,
      sourceTrust: null, body,
    });
    expect(new Date(savedComment!.createdAt).getTime()).toBe(new Date(savedComment!.updatedAt).getTime());
    const publications: ActivityPublication[] = [];
    await logActivity(db, {
      companyId, actorType: "user", actorId: owner, action: "issue.comment_added",
      entityType: "issue", entityId: issueId, details: { commentId: comment.id },
    }, publications);
    expect(publications).toHaveLength(1);
    const event = publications[0]!.pluginEvent;
    expect(event).toMatchObject({ eventType: "issue.comment.created", companyId,
      entityType: "issue", entityId: issueId, actorType: "user", actorId: owner,
      payload: { commentId: comment.id, agentId: null, runId: null, responsibleUserId: owner },
    });
    if (!event) throw new Error("Activity did not create a plugin event");

    const harness = createTestHarness({ manifest: wikiManifest, config: {
      ownerCommentRawCapture: { version: 1, enabled: true, spaceSlug: "owner-notes",
        ownerUserId: owner, issueIds: [issueId], maxBodyBytes: 250000, allowCompanyReaders: true,
        classification: { label: "internal", decidedByUserId: owner,
          decidedAt: event.occurredAt, decisionRef: "synthetic-real-path" } },
    } });
    harness.ctx.db.namespace = namespace;
    harness.ctx.db.query = <T,>(statement: string, params?: unknown[]) => pluginDb.query<T>(pluginId, statement, params);
    harness.ctx.db.execute = (statement, params) => pluginDb.execute(pluginId, statement, params);
    harness.ctx.issues.get = (id, company) => host.issues.get({ issueId: id, companyId: company });
    harness.ctx.issues.listComments = (id, company) => host.issues.listComments({ issueId: id, companyId: company });
    harness.ctx.localFolders.status = (company, folderKey) => host.localFolders.status({ companyId: company, folderKey });
    harness.ctx.localFolders.createTextExclusive = (company, folderKey, relativePath, contents) =>
      host.localFolders.createTextExclusive({ companyId: company, folderKey, relativePath, contents });
    harness.ctx.localFolders.readText = (company, folderKey, relativePath) =>
      host.localFolders.readText({ companyId: company, folderKey, relativePath });

    expect(await Promise.all([
      captureOwnerCommentRaw(harness.ctx, event),
      captureOwnerCommentRaw(harness.ctx, event),
    ])).toEqual(["verified", "verified"]);
    const received = await readOwnerCommentRaw(harness.ctx, companyId, comment.id);
    expect(received.source).toBe(body);
    expect(received.receipt.status).toBe("verified");
    expect(received.receipt.rawPath).toBe(
      `spaces/owner-notes/.paperclip/owner-comment-raw/${spaceId}/${comment.id}/${received.receipt.bodySha256}.txt`,
    );
    const leaf = path.join(root, received.receipt.rawPath);
    expect(await fs.readFile(leaf, "utf8")).toBe(body);
    expect((await fs.stat(leaf)).mode & 0o777).toBe(0o600);
    const rows = await db.execute(sql`SELECT status, comment_id FROM
      ${sql.raw(`"${namespace}"."paperclip_owner_raw_captures"`)} WHERE company_id=${companyId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "verified", comment_id: comment.id });
    expect(await fs.readdir(path.dirname(leaf))).toEqual([path.basename(leaf)]);
    harness.ctx.issues.getSubtree = async () => ({
      rootIssueId: issueId, issues: [await host.issues.get({ issueId, companyId })],
      relations: [], documents: [], assignees: [],
    } as never);
    const normalization = await createPaperclipDistillationRun(harness.ctx, {
      companyId, spaceSlug: "owner-notes", rootIssueId: issueId, includeDocuments: false,
    });
    expect(normalization.status).toBe("source_ready");
    const sourceRef = normalization.bundle.sourceRefs.find(ref => ref.commentId === comment.id);
    expect(sourceRef?.rawCapture).toMatchObject({ status: "verified",
      bodySha256: received.receipt.bodySha256, bodyBytes: Buffer.byteLength(body),
      commentUpdatedAt: received.receipt.commentUpdatedAt, rawPath: received.receipt.rawPath });
    const snapshots = await db.execute(sql`SELECT source_hash, source_refs, bundle_markdown FROM
      ${sql.raw(`"${namespace}"."paperclip_source_snapshots"`)}
      WHERE company_id=${companyId} AND id=${normalization.snapshotId}`);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.source_hash).toBe(normalization.bundle.sourceHash);
    expect(snapshots[0]!.source_refs).toEqual(normalization.bundle.sourceRefs);
    expect(snapshots[0]!.bundle_markdown).toContain(body);
    expect(await fs.readFile(leaf, "utf8")).toBe(received.source);
    const pages = await db.execute(sql`SELECT id FROM ${sql.raw(`"${namespace}"."wiki_pages"`)}
      WHERE company_id=${companyId}`);
    expect(pages).toHaveLength(0);
    if (process.env.PAPERCLIP_RAW_HANDOFF_RECEIPT) {
      await fs.writeFile(process.env.PAPERCLIP_RAW_HANDOFF_RECEIPT, JSON.stringify({
        syntheticOnly: true, commentId: comment.id, issueId, spaceId,
        rawBodySha256: received.receipt.bodySha256, rawBodyBytes: Buffer.byteLength(body),
        rawPath: received.receipt.rawPath, rawFileMode: (await fs.stat(leaf)).mode & 0o777,
        normalizationRunId: normalization.runId, normalizationSnapshotId: normalization.snapshotId,
        normalizationSourceHash: normalization.bundle.sourceHash, rawReference: sourceRef?.rawCapture,
        persistedSnapshotCount: snapshots.length, sharedWikiPageCount: pages.length,
      }, null, 2) + "\n", { mode: 0o600 });
    }
  }, 90_000);

  it("rejects worker local-folder access for undeclared manifest keys", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.local-folders",
      packageName: "@paperclip/plugin-local-folders",
      version: "0.1.0",
      manifestJson: {
        id: "paperclip.local-folders",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "Local Folders",
        description: "Local folder fixture",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        entrypoints: { worker: "./dist/worker.js" },
        localFolders: [
          {
            folderKey: "content-root",
            displayName: "Content root",
            access: "readWrite",
          },
        ],
      },
      status: "ready",
    });
    const services = buildHostServices(
      db,
      pluginId,
      "paperclip.local-folders",
      createEventBusStub(),
      undefined,
      {
        manifest: {
          id: "paperclip.local-folders",
          apiVersion: 1,
          version: "0.1.0",
          displayName: "Local Folders",
          description: "Local folder fixture",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["local.folders"],
          entrypoints: { worker: "./dist/worker.js" },
          localFolders: [
            {
              folderKey: "content-root",
              displayName: "Content root",
              access: "readWrite",
            },
          ],
        },
      },
    );
    await expect(services.localFolders.configure({
      companyId,
      folderKey: "ssh",
      path: "/tmp",
      access: "read",
    })).rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.status({ companyId, folderKey: "ssh" }))
      .rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.readText({ companyId, folderKey: "ssh", relativePath: "id_rsa" }))
      .rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.writeTextAtomic({
      companyId,
      folderKey: "ssh",
      relativePath: "id_rsa",
      contents: "secret",
    })).rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.createTextExclusive({
      companyId,
      folderKey: "ssh",
      relativePath: "id_rsa",
      contents: "secret",
    })).rejects.toThrow("Local folder key is not declared");
  });

  it("resolves plugin-managed projects by stable key without overwriting user edits", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.missions",
      packageName: "@paperclip/plugin-missions",
      version: "0.1.0",
      apiVersion: 1,
      categories: ["automation"],
      status: "ready",
      manifestJson: {
        id: "paperclip.missions",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "Missions",
        description: "Mission orchestration",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["projects.managed"],
        entrypoints: { worker: "./dist/worker.js" },
        projects: [{
          projectKey: "operations",
          displayName: "Mission Operations",
          description: "Plugin operation inspection area",
          status: "in_progress",
          color: "#14b8a6",
          settings: { surface: "operations" },
        }],
      },
    });

    const services = buildHostServices(db, pluginId, "paperclip.missions", createEventBusStub());
    const missing = await services.projects.getManaged({ companyId, projectKey: "operations" });
    expect(missing.status).toBe("missing");
    expect(missing.projectId).toBeNull();
    await expect(
      db
        .select()
        .from(pluginManagedResources)
        .where(and(
          eq(pluginManagedResources.companyId, companyId),
          eq(pluginManagedResources.pluginId, pluginId),
          eq(pluginManagedResources.resourceKind, "project"),
          eq(pluginManagedResources.resourceKey, "operations"),
        )),
    ).resolves.toHaveLength(0);

    const created = await services.projects.reconcileManaged({ companyId, projectKey: "operations" });

    expect(created.status).toBe("created");
    expect(created.projectId).toEqual(expect.any(String));
    expect(created.project?.managedByPlugin).toMatchObject({
      pluginId,
      pluginKey: "paperclip.missions",
      pluginDisplayName: "Missions",
      resourceKind: "project",
      resourceKey: "operations",
    });

    await db
      .update(projects)
      .set({ name: "Renamed by operator", description: "User-owned text", updatedAt: new Date() })
      .where(eq(projects.id, created.projectId!));
    await db
      .update(plugins)
      .set({
        manifestJson: {
          id: "paperclip.missions",
          apiVersion: 1,
          version: "0.2.0",
          displayName: "Missions",
          description: "Mission orchestration",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["projects.managed"],
          entrypoints: { worker: "./dist/worker.js" },
          projects: [{
            projectKey: "operations",
            displayName: "Upgraded Default Name",
            description: "Upgraded default description",
            status: "planned",
            color: "#f97316",
            settings: { surface: "operations", upgraded: true },
          }],
        },
        updatedAt: new Date(),
      })
      .where(eq(plugins.id, pluginId));

    const resolved = await services.projects.reconcileManaged({ companyId, projectKey: "operations" });

    expect(resolved.status).toBe("resolved");
    expect(resolved.projectId).toBe(created.projectId);
    expect(resolved.project?.name).toBe("Renamed by operator");
    expect(resolved.project?.description).toBe("User-owned text");
    expect(resolved.project?.managedByPlugin?.defaultsJson).toMatchObject({
      displayName: "Upgraded Default Name",
      settings: { upgraded: true },
    });
  });

  it("asserts checkout ownership for run-scoped plugin actions", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checked out issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    await expect(
      services.issues.assertCheckoutOwner({
        issueId,
        companyId,
        actorAgentId: agentId,
        actorRunId: runId,
      }),
    ).resolves.toMatchObject({
      issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
    });
  });

  it("refuses plugin wakeups for issues with unresolved blockers", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Unresolved blocker",
        status: "todo",
        priority: "medium",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    await expect(
      services.issues.requestWakeup({
        issueId: blockedIssueId,
        companyId,
        reason: "mission_advance",
      }),
    ).rejects.toThrow("Issue is blocked by unresolved blockers");
  });

  it("narrows orchestration cost summaries by subtree and billing code", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
      {
        id: unrelatedIssueId,
        companyId,
        title: "Different mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: rootIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 2,
        costCents: 100,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 20,
        cachedInputTokens: 2,
        outputTokens: 4,
        costCents: 200,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        billingCode: "mission:beta",
        provider: "test",
        model: "unit",
        inputTokens: 30,
        cachedInputTokens: 3,
        outputTokens: 6,
        costCents: 300,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: unrelatedIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 40,
        cachedInputTokens: 4,
        outputTokens: 8,
        costCents: 400,
        occurredAt: new Date(),
      },
    ]);

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const summary = await services.issues.getOrchestrationSummary({
      companyId,
      issueId: rootIssueId,
      includeSubtree: true,
    });

    expect(new Set(summary.subtreeIssueIds)).toEqual(new Set([rootIssueId, childIssueId]));
    expect(summary.costs).toMatchObject({
      billingCode: "mission:alpha",
      costCents: 300,
      inputTokens: 30,
      cachedInputTokens: 3,
      outputTokens: 6,
    });
  });

  it("rejects a human-attributed plugin comment when actorUserId is not an active company member", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs human input",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.issues.createComment({
        issueId,
        companyId,
        body: "Here's my answer",
        actorUserId: randomUUID(),
      }),
    ).rejects.toThrow("is not an active human member of this company");

    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
  });

  it("rejects a human-attributed plugin comment when actorUserId is a viewer-role (read-only) member", async () => {
    // LOOA-648: a viewer is a real active member but is read-only in the web
    // app (routes/authz.ts "Viewer access is read-only"). Attributing a comment
    // to them is a write the paired user could not make interactively.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const viewerUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: viewerUserId, status: "active", membershipRole: "viewer",
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Needs human input", status: "in_review", priority: "medium", assigneeAgentId: agentId,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.issues.createComment({ issueId, companyId, body: "Here's my answer", actorUserId: viewerUserId }),
    ).rejects.toThrow("viewer (read-only) access");

    // No comment persisted, no assignee woken.
    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
    const comments = await services.issues.listComments({ issueId, companyId });
    expect(comments).toHaveLength(0);
  });

  it("creates a human-attributed plugin comment and wakes the issue's assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const humanUserId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: humanUserId,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs human input",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    // Cap concurrency at 1 and pre-seed a running run so enqueueWakeup's
    // queued-run bookkeeping is exercised without startNextQueuedRunForAgent
    // going on to actually claim/execute the new run — that path spins up
    // real environment/adapter orchestration this test has no business
    // depending on (and which races the test's own db teardown).
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: {},
    });

    const services = buildHostServices(
      db,
      "plugin-record-id",
      "paperclip.gateway",
      createEventBusStub(),
      undefined,
      { heartbeatRuntimeEnv: {} },
    );
    const comment = await services.issues.createComment({
      issueId,
      companyId,
      body: "Here's my answer",
      actorUserId: humanUserId,
    });

    expect(comment).toMatchObject({
      authorType: "user",
      authorUserId: humanUserId,
      authorAgentId: null,
      body: "Here's my answer",
    });

    const [wakeupRequest] = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
    expect(wakeupRequest).toMatchObject({
      reason: "issue_commented",
      requestedByActorType: "user",
      requestedByActorId: humanUserId,
    });
    expect(wakeupRequest?.status).toBe("queued");
    expect(wakeupRequest?.runId).toEqual(expect.any(String));

    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wakeupRequest!.runId!));
    expect(run).toMatchObject({ agentId, companyId, status: "queued" });
  });

  it("skips the assignee wakeup when the issue is cancelled concurrently with the comment being written", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const humanUserId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: humanUserId,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs human input",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());

    // Hold a row lock on the issue so createComment's own `UPDATE issues SET
    // updated_at` (inside addComment) blocks until this transaction commits a
    // concurrent cancellation. That deterministically reproduces "another
    // request closes the issue while the comment is being written" — the
    // race Greptile flagged on the pre-insert `issue` snapshot — without
    // relying on timing luck for the outcome, only for scheduling.
    const lockAndCancelPromise = db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await tx.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issueId));
    });

    const commentPromise = services.issues.createComment({
      issueId,
      companyId,
      body: "Here's my answer",
      actorUserId: humanUserId,
    });

    const [comment] = await Promise.all([commentPromise, lockAndCancelPromise]);

    expect(comment).toMatchObject({
      authorType: "user",
      authorUserId: humanUserId,
      body: "Here's my answer",
    });
    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // LOOA-641 — interactions.respond / approvals.decide impersonation surface.
  // The host must independently re-verify the paired user's active membership
  // at apply time and never trust the plugin-supplied identity.
  // ---------------------------------------------------------------------------

  async function seedInteraction(
    companyId: string,
    issueId: string,
    overrides: Partial<typeof issueThreadInteractions.$inferInsert> = {},
  ) {
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Proceed?" } as never,
      ...overrides,
    });
    return interactionId;
  }

  it("respondInteraction fails closed when actorUserId is omitted", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Decision", status: "in_review", priority: "medium", assigneeAgentId: agentId,
    });
    const interactionId = await seedInteraction(companyId, issueId);
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.issues.respondInteraction({ issueId, interactionId, companyId, action: "accept" }),
    ).rejects.toThrow("actorUserId is required");
  });

  it("respondInteraction rejects an actorUserId that is not an active company member", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Decision", status: "in_review", priority: "medium", assigneeAgentId: agentId,
    });
    const interactionId = await seedInteraction(companyId, issueId);
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.issues.respondInteraction({
        issueId, interactionId, companyId, action: "accept", actorUserId: randomUUID(),
      }),
    ).rejects.toThrow("is not an active human member of this company");

    // The interaction must remain pending — no resolution was applied.
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(row?.status).toBe("pending");
  });

  it("respondInteraction rejects a viewer-role active member and leaves the interaction pending", async () => {
    // LOOA-648: viewers are read-only board members (routes/authz.ts). A plugin
    // holding issue.interactions.respond must not resolve an interaction on
    // their behalf — that is a write the viewer is 403'd on in the web app.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const viewerUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: viewerUserId, status: "active", membershipRole: "viewer",
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Decision", status: "in_review", priority: "medium", assigneeAgentId: agentId,
    });
    const interactionId = await seedInteraction(companyId, issueId);
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.issues.respondInteraction({
        issueId, interactionId, companyId, action: "accept", actorUserId: viewerUserId,
      }),
    ).rejects.toThrow("viewer (read-only) access");

    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(row?.status).toBe("pending");
  });

  it("respondInteraction applies for a non-viewer human role (operator)", async () => {
    // LOOA-648 regression: owner/admin/operator must still pass the write bar.
    // Issue has no assignee so the continuation wakeup is a no-op — this
    // isolates the membership check from run orchestration.
    const { companyId } = await seedCompanyAndAgent();
    const operatorUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: operatorUserId, status: "active", membershipRole: "operator",
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Decision", status: "in_review", priority: "medium",
    });
    const interactionId = await seedInteraction(companyId, issueId);
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    const result = await services.issues.respondInteraction({
      issueId, interactionId, companyId, action: "accept", actorUserId: operatorUserId,
    });
    expect(result.applied).toBe(true);
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(row?.status).toBe("accepted");
  });

  it.each(["accept", "reject"] as const)(
    "respondInteraction rejects %s after the issue closes",
    async (action) => {
      const { companyId } = await seedCompanyAndAgent();
      const operatorUserId = randomUUID();
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: operatorUserId,
        status: "active",
        membershipRole: "operator",
      });
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Closed decision",
        status: "done",
        priority: "medium",
      });
      const interactionId = await seedInteraction(companyId, issueId);
      const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());

      await expect(services.issues.respondInteraction({
        issueId,
        interactionId,
        companyId,
        action,
        actorUserId: operatorUserId,
      })).rejects.toThrow("Interaction is no longer actionable because the issue is closed");

      const [row] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      expect(row?.status).toBe("pending");
    },
  );

  it("respondInteraction converges (applied:false) when the interaction is already resolved", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const humanUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: humanUserId, status: "active", membershipRole: "owner",
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Decision", status: "in_review", priority: "medium", assigneeAgentId: agentId,
    });
    const interactionId = await seedInteraction(companyId, issueId, { status: "rejected" });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    const result = await services.issues.respondInteraction({
      issueId, interactionId, companyId, action: "accept", actorUserId: humanUserId,
    });
    expect(result.applied).toBe(false);
    expect(result.interaction).toMatchObject({ id: interactionId, status: "rejected" });
  });

  it("approvals.decide fails closed when actorUserId is omitted", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: { title: "Ship it" },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.approvals.decide({ approvalId, companyId, action: "approve" }),
    ).rejects.toThrow("actorUserId is required");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.status).toBe("pending");
  });

  it("approvals.decide rejects an actorUserId that is not an active company member", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: { title: "Ship it" },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.approvals.decide({ approvalId, companyId, action: "approve", actorUserId: randomUUID() }),
    ).rejects.toThrow("is not an active human member of this company");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.status).toBe("pending");
  });

  it("approvals.decide rejects a viewer-role active member and leaves the approval pending", async () => {
    // LOOA-648: the exploit at the heart of the review — a plugin holding
    // approvals.respond decides an approval for a viewer who is 403'd in the
    // web UI. The host must reject the viewer before applying the decision.
    const { companyId } = await seedCompanyAndAgent();
    const viewerUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: viewerUserId, status: "active", membershipRole: "viewer",
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: { title: "Ship it" },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.approvals.decide({ approvalId, companyId, action: "approve", actorUserId: viewerUserId }),
    ).rejects.toThrow("viewer (read-only) access");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.status).toBe("pending");
  });

  it("approvals.decide applies for a non-viewer human role (admin)", async () => {
    // LOOA-648 regression: owner/admin/operator must still pass the write bar.
    const { companyId } = await seedCompanyAndAgent();
    const adminUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: adminUserId, status: "active", membershipRole: "admin",
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: { title: "Ship it" },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    const result = await services.approvals.decide({
      approvalId, companyId, action: "approve", actorUserId: adminUserId,
    });
    expect(result.applied).toBe(true);
    expect(result.approval).toMatchObject({ id: approvalId, status: "approved", decidedByUserId: adminUserId });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.status).toBe("approved");
  });

  it("approvals.decide applies for an active member and redacts secret payload fields", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const humanUserId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: humanUserId, status: "active", membershipRole: "owner",
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Ship it", botToken: "xoxb-super-secret" },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    const result = await services.approvals.decide({
      approvalId, companyId, action: "approve", actorUserId: humanUserId, decisionNote: "lgtm",
    });
    expect(result.applied).toBe(true);
    expect(result.approval).toMatchObject({ id: approvalId, status: "approved", decidedByUserId: humanUserId });
    // Bridge output must be redacted the same way the web app redacts approvals.
    expect(result.approval.payload.title).toBe("Ship it");
    expect(result.approval.payload.botToken).toBe("***REDACTED***");

    // Persisted row is decided; the raw stored secret is untouched (redaction is
    // an output transform, not a mutation).
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.status).toBe("approved");
  });

  it("approvals.list redacts payloads and is company-scoped", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const otherCompany = randomUUID();
    await db.insert(companies).values({
      id: otherCompany, name: "Other", issuePrefix: issuePrefix(otherCompany), requireBoardApprovalForNewAgents: false,
    });
    await db.insert(approvals).values({
      id: randomUUID(), companyId, type: "request_board_approval", status: "pending",
      payload: { title: "Mine", accessToken: "sekret" },
    });
    await db.insert(approvals).values({
      id: randomUUID(), companyId: otherCompany, type: "request_board_approval", status: "pending",
      payload: { title: "Theirs" },
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    const rows = await services.approvals.list({ companyId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.title).toBe("Mine");
    expect(rows[0]!.payload.accessToken).toBe("***REDACTED***");
  });

  it("getAttachmentContent returns null for a cross-company attachment id", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherCompany = randomUUID();
    await db.insert(companies).values({
      id: otherCompany, name: "Other", issuePrefix: issuePrefix(otherCompany), requireBoardApprovalForNewAgents: false,
    });
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId, companyId: otherCompany, title: "Theirs", status: "todo", priority: "medium",
    });
    const assetId = randomUUID();
    await db.insert(assets).values({
      id: assetId, companyId: otherCompany, provider: "local_disk", objectKey: "k", contentType: "image/png",
      byteSize: 10, sha256: "abc",
    });
    const attachmentId = randomUUID();
    await db.insert(issueAttachments).values({
      id: attachmentId, companyId: otherCompany, issueId: otherIssueId, assetId,
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    // Requested under our own company: the cross-company id must be invisible.
    void agentId;
    const content = await services.issues.getAttachmentContent({ attachmentId, companyId });
    expect(content).toBeNull();
  });

  it("getAttachmentContent refuses an over-cap attachment", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Has asset", status: "todo", priority: "medium",
    });
    const assetId = randomUUID();
    await db.insert(assets).values({
      id: assetId, companyId, provider: "local_disk", objectKey: "k", contentType: "image/png",
      byteSize: 5_000_000, sha256: "abc",
    });
    const attachmentId = randomUUID();
    await db.insert(issueAttachments).values({
      id: attachmentId, companyId, issueId, assetId,
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", createEventBusStub());
    await expect(
      services.issues.getAttachmentContent({ attachmentId, companyId, maxBytes: 1_000_000 }),
    ).rejects.toThrow("over the");
  });
});
