import { beforeEach, expect, test, vi } from "vitest";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { publicationCanonical, publicationHash } from "../services/wiki-publication-readback.js";
import type { Db } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const state = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  document: {} as Record<string, unknown>,
  review: {} as Record<string, unknown>,
  settingsReads: [] as unknown[][],
}));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({ getConfig: async (...args: unknown[]) => {
    state.settingsReads.push(args); return { configJson: state.config };
  } }),
}));
vi.mock("../services/documents.js", () => ({
  documentService: () => ({ getIssueDocumentByKey: async () => state.document }),
}));
vi.mock("../services/issue-thread-interactions.js", () => ({
  issueThreadInteractionService: () => ({ listForIssue: async () => [state.review] }),
}));
vi.mock("../middleware/logger.js", () => {
  const log = { child: () => log, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  return { logger: log };
});

const pluginKey = "paperclipai.plugin-llm-wiki";
const pluginDbId = "00000000-0000-4000-8000-000000000001";
const name = `${pluginKey}:wiki_read_page`;
const context = { companyId: "company", agentId: "employee", runId: "run", projectId: "project" };

beforeEach(() => { state.settingsReads = []; });

function setup() {
  const body = "Reviewed synthetic company document";
  const ref = { kind: "document", issueId: "issue", documentId: "document", documentKey: "note", revisionId: "revision" };
  state.document = { id: "document", companyId: "company", issueId: "issue", latestRevisionId: "revision", body };
  state.review = { id: "review", companyId: "company", issueId: "issue", status: "accepted", sourceRunId: "writer-run", resolvedByAgentId: "qa", resolvedByRunId: "qa-run", resolvedAt: null, payload: {}, result: { outcome: "accepted" } };
  const page = { path: "wiki/note.md", wikiId: "default", spaceSlug: "default", contents: body, hash: publicationHash(body), sourceRefs: [ref] };
  state.config = { publicationReadback: { schema: "colo.shared-wiki-publication-readback/v1", companyId: "company", wikiId: "default", spaceSlug: "default", qaAgentId: "qa", entries: [{ path: page.path, ...ref, producerAgentId: "writer", reviewId: "review", wikiSHA256: page.hash, documentBodySHA256: publicationHash(body), reviewRecordSHA256: publicationHash(publicationCanonical(state.review)), sourceRefsSHA256: publicationHash(publicationCanonical(page.sourceRefs)) }] } };
  const workerResult = { content: body, data: { companyId: "company", wikiId: "default", spaceSlug: "default", path: page.path, hash: page.hash } };
  const call = vi.fn(async (id: string, method: string) => {
    expect(id).toBe(pluginDbId);
    if (method === "executeTool") return workerResult;
    if (method === "getData") return page;
    throw new Error("unexpected worker operation");
  });
  const workerManager = { isRunning: () => true, call } as unknown as PluginWorkerManager;
  const dispatcher = createPluginToolDispatcher({ db: {} as Db, workerManager });
  dispatcher.registerPluginTools(pluginKey, { id: pluginKey, tools: [{ name: "wiki_read_page", displayName: "Read", description: "Read", parametersSchema: { type: "object" } }] } as unknown as PaperclipPluginManifestV1, pluginDbId);
  const run = (args = { companyId: "company", path: page.path } as Record<string, unknown>) => dispatcher.executeTool(name, args, context);
  return { run, call, body, workerResult };
}

test("normal dispatcher adds current publication evidence through the UUID worker", async () => {
  const f = setup(); const result = await f.run();
  expect(result.result.content).toBe(f.body);
  expect(result.result.data).toMatchObject({ publicationReadback: { state: "verified", citation: { documentId: "document" } } });
  expect(state.settingsReads).toEqual([[pluginDbId, "company"]]);
  expect(f.call).toHaveBeenCalledWith(pluginDbId, "getData", { key: "page-content", companyId: "company", params: { companyId: "company", wikiId: "default", spaceSlug: "default", path: "wiki/note.md" } });
});
test("companies without the operator configuration keep their existing tool result", async () => {
  const f = setup(); state.config = {}; const result = await f.run();
  expect(result.result).toEqual(f.workerResult); expect(f.call).toHaveBeenCalledTimes(1);
});
test("the ordinary tool call refuses a changed current document", async () => {
  const f = setup(); state.document.latestRevisionId = "later-revision";
  await expect(f.run()).rejects.toThrow("wiki_publication_document_changed");
});
test("the ordinary tool call refuses a revoked QA receipt", async () => {
  const f = setup(); state.review.status = "rejected";
  await expect(f.run()).rejects.toThrow("wiki_publication_review_not_accepted");
});
test("an existing worker error is preserved without looking up publication data", async () => {
  const f = setup(); Object.assign(f.workerResult, { error: "read failed" });
  const result = await f.run(); expect(result.result.error).toBe("read failed");
  expect(state.settingsReads).toHaveLength(0); expect(f.call).toHaveBeenCalledTimes(1);
});


test("dispatcher verifies resolved aliases with canonical worker read scope", async () => {
  const f = setup();
  const args = { companyId: "company", path: "/wiki/note.md", wikiId: " default ", spaceSlug: "DEFAULT" };
  const result = await f.run(args);
  expect(result.result.data).toMatchObject({ publicationReadback: { state: "verified" } });
  expect(f.call).toHaveBeenCalledWith(pluginDbId, "getData", { key: "page-content", companyId: "company", params: { companyId: "company", wikiId: "default", spaceSlug: "default", path: "wiki/note.md" } });
  state.review.status = "rejected";
  await expect(f.run(args)).rejects.toThrow("wiki_publication_review_not_accepted");
});
