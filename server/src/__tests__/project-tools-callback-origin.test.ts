import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const state = vi.hoisted(() => ({
  handler: null as null | ((req: Request, res: Response) => Promise<unknown>),
  documentMode: false,
  call: vi.fn(async (_input: Record<string, unknown>) => ({ outcome: "verified" })),
}));

vi.mock("express", () => ({ Router: () => ({
  post: (_path: string, handler: typeof state.handler) => { state.handler = handler; },
}) }));
vi.mock("../services/project-tool-context.js", () => ({
  projectToolContext: async () => ({
    issue: { id: "issue", workMode: "standard" },
    run: { companyId: "company", agentId: "agent", contextSnapshot: {
      paperclipSelfTaskDocumentToolsOnly: state.documentMode,
    } },
  }),
}));
vi.mock("../routes/authz.js", () => ({ assertCompanyAccess: vi.fn() }));
vi.mock("../services/project-tools.js", async (load) => ({
  ...await load<typeof import("../services/project-tools.js")>(),
  callProjectTool: state.call,
}));

import { projectToolRoutes } from "../routes/project-tools.js";

beforeEach(() => {
  state.documentMode = false;
  state.call.mockClear();
  vi.stubEnv("PAPERCLIP_API_URL", "https://configured.example.invalid");
  projectToolRoutes({} as never);
});
afterEach(() => vi.unstubAllEnvs());

async function invoke(socket: Record<string, unknown>) {
  const req = {
    actor: {}, socket,
    body: { method: "tools/call", params: {
      name: state.documentMode ? "read_self_task_document" : "list_projects", arguments: {},
    } },
    header: () => "Bearer synthetic-run-token",
  };
  const res = { json: vi.fn((value) => value) };
  await state.handler!(req as unknown as Request, res as unknown as Response);
  return res;
}

describe("project tool callback origin", () => {
  it("keeps the configured origin for an ordinary run even when a local listener exists", async () => {
    await invoke({ localAddress: "127.0.0.1", localPort: 3100 });
    expect(state.call).toHaveBeenCalledOnce();
    expect(state.call.mock.calls[0]![0]).toMatchObject({
      apiUrl: "https://configured.example.invalid", name: "list_projects",
    });
  });

  it("preserves the configured origin for an ordinary run without a local socket", async () => {
    await invoke({});
    expect(state.call).toHaveBeenCalledOnce();
    expect(state.call.mock.calls[0]![0]).toMatchObject({
      apiUrl: "https://configured.example.invalid", name: "list_projects",
    });
  });

  it("keeps document-run credentials on the accepting listener", async () => {
    state.documentMode = true;
    await invoke({ localAddress: "127.0.0.1", localPort: 3100 });
    expect(state.call).toHaveBeenCalledOnce();
    expect(state.call.mock.calls[0]![0]).toMatchObject({
      apiUrl: "http://127.0.0.1:3100", name: "read_self_task_document",
    });
  });

  it("does not send a document-run credential to the configured origin when its listener is missing", async () => {
    state.documentMode = true;
    const res = await invoke({});
    expect(state.call).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ isError: true }),
    }));
  });
});
