import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";
import { createHash, randomUUID } from "node:crypto";

const input = {
  name: "list_projects", arguments: {}, apiUrl: "http://paperclip.test", token: "test-token",
  companyId: "company", issueId: "issue", agentId: "agent", conversation: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("project discovery result bounds", () => {
  it("offers only the two bounded document tools to an opted-in task run", () => {
    expect(projectToolDefinitions("standard", true, true).map(tool => tool.name)).toEqual([
      "read_self_task_document", "write_self_task_document",
    ]);
    // The dedicated document capability follows the canonical document catalog,
    // independently of the generic project-creation work-mode gate.
    expect(projectToolDefinitions("planning", true, true).map(tool => tool.name)).toContain("write_self_task_document");
  });

  it("keeps ordinary project and task tool lists unchanged without opt-in", () => {
    expect(projectToolDefinitions("standard", true).map(tool => tool.name).sort()).toEqual([
      "create_project", "create_task", "list_project_repositories", "list_projects", "set_task_title",
    ]);
    expect(projectToolDefinitions("standard").map(tool => tool.name).sort()).toEqual([
      "create_project", "list_project_repositories", "list_projects",
    ]);
  });

  it("requests bounded summaries and normalizes continuation cursors", async () => {
    const page = { projects: [{ id: "abcdefab-0000-4000-8000-000000000001", name: "Project", status: "in_progress", description: "Summary", descriptionTruncated: true }], nextCursor: "abcdefab-0000-4000-8000-000000000001" };
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => page }));
    vi.stubGlobal("fetch", fetch);
    expect(await callProjectTool(input)).toEqual(page);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://paperclip.test/api/companies/company/projects?view=summary&limit=50");
    await callProjectTool({ ...input, arguments: { limit: 3, cursor: page.nextCursor.toUpperCase() } });
    expect(fetch.mock.calls[1]?.[0]).toBe(`http://paperclip.test/api/companies/company/projects?view=summary&limit=3&cursor=${page.nextCursor}`);
    expect(projectToolDefinitions("standard").find(t => t.name === "list_projects")?.inputSchema)
      .toMatchObject({ properties: { cursor: expect.any(Object), limit: expect.any(Object) } });
  });

  it.each([{ limit: 0 }, { limit: 51 }, { cursor: "invalid" }])("rejects invalid paging arguments %j before fetching", async (arguments_) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(callProjectTool({ ...input, arguments: arguments_ })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("records an unknown postcommit PUT response without replaying the write", async () => {
    const companyId = randomUUID(), issueId = randomUUID(), documentId = randomUUID(), revisionId = randomUUID();
    const body = "Synthetic fixed input";
    let persistedWrites = 0;
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "GET") return { ok: true, redirected: false, status: 200,
        json: async () => [{ id: revisionId, companyId, issueId, key: "notes", documentId,
          body, revisionNumber: 1 }] };
      persistedWrites++;
      // The server commits, but the client loses the PUT acknowledgement.
      throw new TypeError("synthetic response lost after commit");
    });
    vi.stubGlobal("fetch", fetch);
    const saved = await callProjectTool({ ...input, companyId, issueId,
      name: "write_self_task_document", arguments: { key: "result", title: "Result",
        format: "markdown", body: "Synthetic result", documentId: null, baseRevisionId: null,
        input: { key: "notes", documentId, revisionId,
          bodySha256: createHash("sha256").update(body).digest("hex") } } });
    expect(saved).toMatchObject({ outcome: "unknown", stage: "put",
      requests: { reads: 1, puts: 1, readbacks: 0 }, reason: "synthetic response lost after commit" });
    expect(persistedWrites).toBe(1);
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(["GET", "PUT"]);
  });
});
