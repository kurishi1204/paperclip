// @vitest-environment jsdom

import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { AgentDetail as AgentRecord, HeartbeatRun } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDetail } from "./AgentDetail";

const navigation = vi.hoisted(() => ({ holdCanonical: false, queued: [] as Array<() => void> }));
const agentsApiMock = vi.hoisted(() => ({ get: vi.fn(), retryFailedRun: vi.fn() }));
const heartbeatsApiMock = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
const companyView = vi.hoisted(() => ({
  companies: [{ id: "company-1", issuePrefix: "PAP" }, { id: "company-2", issuePrefix: "BBB" }],
  selectedCompanyId: "company-1" as string | null,
  version: 0,
  listeners: new Set<() => void>(),
}));

vi.mock("@/lib/router", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/router")>();
  return {
    ...original,
    useNavigate: () => {
      const navigate = original.useNavigate();
      return ((to: string, options?: { replace?: boolean }) => {
        if (navigation.holdCanonical && to.includes("/agents/maya/runs/")) {
          navigation.queued.push(() => navigate(to, options));
          return;
        }
        navigate(to, options);
      }) as ReturnType<typeof original.useNavigate>;
    },
  };
});
vi.mock("../api/agents", () => ({ agentsApi: agentsApiMock }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: heartbeatsApiMock }));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: vi.fn(async () => ({})) } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn(async () => ({})) } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => {
    useSyncExternalStore(
      (listener) => { companyView.listeners.add(listener); return () => { companyView.listeners.delete(listener); }; },
      () => companyView.version,
    );
    return {
      companies: companyView.companies,
      selectedCompanyId: companyView.selectedCompanyId,
      setSelectedCompanyId: vi.fn(),
      selectedCompany: { id: "company-1", issuePrefix: "PAP" },
    };
  },
}));
vi.mock("../context/PanelContext", () => ({ usePanel: () => ({ closePanel: vi.fn() }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../hooks/useResourceMemberships", () => ({
  useResourceMemberships: () => ({ data: undefined }),
  useResourceMembershipMutation: () => ({ mutate: vi.fn(), isPending: false }),
  resourceMembershipState: () => "joined",
  isStarred: () => false,
}));
vi.mock("../components/AgentCharacter", () => ({ AgentCharacter: () => <span /> }));
vi.mock("../components/AgentActionButtons", () => ({ AgentActionButtons: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../components/RunWorkspaceRecoverySurface", () => ({ RunWorkspaceRecoverySurface: () => null }));
vi.mock("@/components/ai-connections/AiConnectionPoolRunDetails", () => ({ AiConnectionPoolRunDetails: () => null }));
vi.mock("../components/RunRetryDetails", () => ({ RunRetryDetails: () => null }));

const agentId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const agent = {
  id: agentId, companyId: "company-1", name: "Maya", urlKey: "maya", status: "active",
  role: "engineer", title: null, adapterType: "codex_local", adapterConfig: {},
  permissions: {}, reportsTo: null, capabilities: null, orgChainHealth: null,
} as unknown as AgentRecord;
const otherAgentId = "33333333-3333-4333-8333-333333333333";
const otherRunId = "44444444-4444-4444-8444-444444444444";
const otherAgent = { ...agent, id: otherAgentId, name: "June", urlKey: "june" } as AgentRecord;
const run = {
  id: runId, companyId: "company-1", agentId, status: "failed", errorCode: "adapter_failed",
  createdAt: "2026-10-26T00:00:00.000Z", startedAt: null, finishedAt: null,
  contextSnapshot: null, resultJson: null, execution: null, usageJson: null,
  sessionIdBefore: null, sessionIdAfter: null, exitCode: 1,
} as unknown as HeartbeatRun;
const otherRun = { ...run, id: otherRunId, agentId: otherAgentId } as HeartbeatRun;
const secondRunSameAgent = { ...run, id: otherRunId } as HeartbeatRun;
const otherCompanyAgent = { ...agent, id: otherAgentId, companyId: "company-2", name: "Maya BBB", urlKey: "maya" } as AgentRecord;
const otherCompanyRun = { ...otherRun, companyId: "company-2" } as HeartbeatRun;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

async function flush() {
  await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function waitFor(assertion: () => void) {
  let last: unknown;
  for (let i = 0; i < 30; i++) {
    try { assertion(); return; } catch (error) { last = error; await flush(); }
  }
  throw last;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  navigation.holdCanonical = true;
  navigation.queued = [];
  companyView.companies = [{ id: "company-1", issuePrefix: "PAP" }, { id: "company-2", issuePrefix: "BBB" }];
  companyView.selectedCompanyId = "company-1";
  companyView.version = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  agentsApiMock.get.mockImplementation(async (ref: string) => ref === otherAgentId || ref === "june" ? otherAgent : agent);
  heartbeatsApiMock.list.mockImplementation(async (_companyId: string, requestedAgentId: string) => requestedAgentId === otherAgentId ? [otherRun] : [run]);
  heartbeatsApiMock.get.mockImplementation(async (requestedRunId: string) => requestedRunId === otherRunId ? otherRun : run);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

describe("AgentDetail retry feedback across canonical navigation", () => {
  function makeRouter(initialPath = `/agents/${agentId}/runs/${runId}`) {
    return createMemoryRouter([
      { path: "/:companyPrefix?/agents/:agentId/runs/:runId", element: <AgentDetail /> },
      { path: "/:companyPrefix?/agents/:agentId/:tab", element: <AgentDetail /> },
      { path: "/:companyPrefix?/activity/runs", element: <p>Run history</p> },
      { path: "/:companyPrefix?/issues/:issueId", element: <p>Issue destination</p> },
      { path: "/outside", element: <p>Outside agent detail</p> },
    ], { initialEntries: [initialPath] });
  }

  async function renderRouter(router: ReturnType<typeof makeRouter>) {
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>); });
    await waitFor(() => expect(retryButton()).toBeTruthy());
  }

  async function updateCompanies(companies: typeof companyView.companies) {
    await act(async () => {
      companyView.companies = companies;
      companyView.version++;
      companyView.listeners.forEach((listener) => listener());
    });
  }

  function retryButton() {
    return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Retry");
  }

  it("redirects a run-less agent runs URL to run history without showing a retry action", async () => {
    navigation.holdCanonical = false;
    const router = makeRouter("/PAP/agents/maya/runs");
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>); });
    await waitFor(() => expect(router.state.location.pathname).toBe("/PAP/activity/runs"));
    expect(router.state.location.search).toBe(`?agentId=${agentId}`);
    expect(container.textContent).toContain("Run history");
    expect(retryButton()).toBeUndefined();
    expect(agentsApiMock.retryFailedRun).not.toHaveBeenCalled();
  });

  async function clickRetry() {
    const button = retryButton();
    if (!button) throw new Error("Retry button missing");
    await act(async () => { button.click(); });
  }

  it("keeps a 409 denial after the UUID run view changes to its canonical slug", async () => {
    const retry = deferred<never>();
    const slug = deferred<AgentRecord>();
    agentsApiMock.get.mockImplementation((ref: string) => ref === "maya" ? slug.promise : Promise.resolve(agent));
    agentsApiMock.retryFailedRun.mockReturnValue(retry.promise);
    const router = makeRouter();
    await renderRouter(router);
    await clickRetry();
    expect(agentsApiMock.retryFailedRun).toHaveBeenCalledTimes(1);
    expect(navigation.queued.length).toBeGreaterThan(0);
    // Mutation invocation and the observer's pending render are separate updates.
    let pendingButton: HTMLButtonElement | undefined;
    await waitFor(() => {
      pendingButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Retrying…");
      expect(pendingButton?.disabled).toBe(true);
    });
    await act(async () => { pendingButton?.click(); });
    expect(agentsApiMock.retryFailedRun).toHaveBeenCalledTimes(1);
    await act(async () => { navigation.holdCanonical = false; navigation.queued.shift()?.(); });
    await waitFor(() => expect(agentsApiMock.get).toHaveBeenCalledWith("maya", "company-1"));
    expect(container.textContent).not.toContain("Retrying…"); // RunDetail has unmounted for the slug query.
    await act(async () => { retry.reject(new Error("409: replay denied")); });
    expect(queryClient.getMutationCache().getAll().some((mutation) =>
      mutation.state.status === "error" && (mutation.state.error as Error)?.message === "409: replay denied",
    )).toBe(true);
    expect(container.textContent).not.toContain("409: replay denied");
    await act(async () => { slug.resolve(agent); });
    await waitFor(() => expect(container.textContent).toContain("409: replay denied"));
    expect(agentsApiMock.retryFailedRun).toHaveBeenCalledTimes(1);
  });

  it("shows a 409 on a settled slug route without a canonical transition", async () => {
    navigation.holdCanonical = false;
    agentsApiMock.retryFailedRun.mockRejectedValue(new Error("steady denial"));
    const router = makeRouter(`/PAP/agents/maya/runs/${runId}`);
    await renderRouter(router);
    await clickRetry();
    await waitFor(() => expect(container.textContent).toContain("steady denial"));
    expect(agentsApiMock.retryFailedRun).toHaveBeenCalledTimes(1);
  });

  it("keeps pending and denial for the same run while company prefix lookup is temporarily unknown", async () => {
    navigation.holdCanonical = false;
    const retry = deferred<never>();
    agentsApiMock.retryFailedRun.mockReturnValue(retry.promise);
    const router = makeRouter(`/PAP/agents/maya/runs/${runId}`);
    await renderRouter(router);
    await clickRetry();
    expect(agentsApiMock.retryFailedRun).toHaveBeenCalledTimes(1);

    await updateCompanies([]);
    let pendingButton: HTMLButtonElement | undefined;
    await waitFor(() => {
      pendingButton = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Retrying…");
      expect(pendingButton?.disabled).toBe(true);
    });
    await act(async () => { pendingButton?.click(); });
    expect(agentsApiMock.retryFailedRun).toHaveBeenCalledTimes(1);

    await act(async () => { retry.reject(new Error("unknown-prefix denial")); });
    await waitFor(() => expect(container.textContent).toContain("unknown-prefix denial"));
    expect(retryButton()?.disabled).toBe(true); // Unknown route identity cannot start a fresh request.
    companyView.selectedCompanyId = "company-2";
    await updateCompanies([]);
    expect(container.textContent).not.toContain("unknown-prefix denial");
    expect(!retryButton() || retryButton()?.disabled).toBe(true);
    await act(async () => { retryButton()?.click(); });
    expect(agentsApiMock.retryFailedRun).toHaveBeenCalledTimes(1);
    companyView.selectedCompanyId = "company-1";
    await updateCompanies([{ id: "company-1", issuePrefix: "PAP" }, { id: "company-2", issuePrefix: "BBB" }]);
    expect(container.textContent).toContain("unknown-prefix denial");
  });

  it("explains an unresolved company next to disabled Retry until the company is confirmed", async () => {
    navigation.holdCanonical = false;
    companyView.companies = [];
    const router = makeRouter(`/PAP/agents/maya/runs/${runId}`);
    await renderRouter(router);

    const button = retryButton();
    expect(button?.disabled).toBe(true);
    const descriptionId = button?.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    const explanation = document.getElementById(descriptionId!);
    expect(explanation?.textContent).toBe("Retry is unavailable until the company is confirmed. Reload the page if this persists.");
    expect(button?.parentElement?.contains(explanation)).toBe(true);
    await clickRetry();
    expect(agentsApiMock.retryFailedRun).not.toHaveBeenCalled();

    await updateCompanies([{ id: "company-1", issuePrefix: "PAP" }]);
    await waitFor(() => expect(retryButton()?.disabled).toBe(false));
    expect(retryButton()?.hasAttribute("aria-describedby")).toBe(false);
    expect(document.getElementById(descriptionId!)).toBeNull();
    expect(agentsApiMock.retryFailedRun).not.toHaveBeenCalled();
  });

  it("explains a deferred successful retry while company confirmation blocks navigation", async () => {
    navigation.holdCanonical = false;
    const retry = deferred<{ runId: null; issueId: string }>();
    agentsApiMock.retryFailedRun.mockReturnValue(retry.promise);
    const originalPath = `/PAP/agents/maya/runs/${runId}`;
    const router = makeRouter(originalPath);
    await renderRouter(router);
    await clickRetry();
    await updateCompanies([]);
    await act(async () => { retry.resolve({ runId: null, issueId: "issue-1" }); });
    await flush();

    expect(router.state.location.pathname).toBe(originalPath);
    expect(retryButton()?.disabled).toBe(true);
    const descriptionId = retryButton()?.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)?.textContent)
      .toBe("Retry is unavailable until the company is confirmed. Reload the page if this persists.");
    expect(agentsApiMock.retryFailedRun).toHaveBeenCalledTimes(1);

    await updateCompanies([{ id: "company-1", issuePrefix: "PAP" }]);
    await waitFor(() => expect(router.state.location.pathname).toBe("/PAP/issues/issue-1"));
    expect(agentsApiMock.retryFailedRun).toHaveBeenCalledTimes(1);
  });

  it("retains a denial that arrives before canonical navigation", async () => {
    agentsApiMock.retryFailedRun.mockRejectedValue(new Error("early denial"));
    const router = makeRouter();
    await renderRouter(router);
    await clickRetry();
    await waitFor(() => expect(container.textContent).toContain("early denial"));
    await act(async () => { navigation.holdCanonical = false; navigation.queued.shift()?.(); });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/PAP/agents/maya/runs/${runId}`));
    await waitFor(() => expect(container.textContent).toContain("early denial"));
    expect(agentsApiMock.retryFailedRun).toHaveBeenCalledTimes(1);
  });

  it("does not display an old denial on another run of the same agent", async () => {
    const oldRetry = deferred<never>();
    heartbeatsApiMock.list.mockResolvedValue([run, secondRunSameAgent]);
    heartbeatsApiMock.get.mockImplementation(async (requestedRunId: string) => requestedRunId === otherRunId ? secondRunSameAgent : run);
    agentsApiMock.retryFailedRun.mockReturnValue(oldRetry.promise);
    const router = makeRouter();
    await renderRouter(router);
    await clickRetry();
    await act(async () => { await router.navigate(`/PAP/agents/maya/runs/${otherRunId}`); });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/PAP/agents/maya/runs/${otherRunId}`));
    await act(async () => { oldRetry.reject(new Error("old run denial")); });
    await flush();
    expect(container.textContent).not.toContain("old run denial");
  });

  it("does not carry an old denial to another run or agent, and never retries the old scope twice", async () => {
    const oldRetry = deferred<never>();
    agentsApiMock.retryFailedRun.mockReturnValueOnce(oldRetry.promise).mockRejectedValueOnce(new Error("new denial"));
    const router = makeRouter(`/agents/${agentId}/runs/${runId}`);
    await renderRouter(router);
    await clickRetry();
    await act(async () => { await router.navigate(`/PAP/agents/${otherAgentId}/runs/${otherRunId}`); });
    await waitFor(() => expect(container.textContent).toContain("June"));
    await act(async () => { oldRetry.reject(new Error("old denial")); });
    await flush();
    expect(container.textContent).not.toContain("old denial");
    await clickRetry();
    await waitFor(() => expect(container.textContent).toContain("new denial"));
    expect(agentsApiMock.retryFailedRun.mock.calls).toEqual([
      [agentId, runId, "company-1"],
      [otherAgentId, otherRunId, "company-1"],
    ]);
  });

  it("does not let an old successful retry navigate the new run", async () => {
    const oldRetry = deferred<{ runId: string; issueId: null }>();
    agentsApiMock.retryFailedRun.mockReturnValue(oldRetry.promise);
    const router = makeRouter();
    await renderRouter(router);
    await clickRetry();
    await act(async () => { await router.navigate(`/PAP/agents/${otherAgentId}/runs/${otherRunId}`); });
    await waitFor(() => expect(container.textContent).toContain("June"));
    await act(async () => { oldRetry.resolve({ runId: "old-successor", issueId: null }); });
    await flush();
    expect(router.state.location.pathname).toBe(`/PAP/agents/june/runs/${otherRunId}`);
    expect(agentsApiMock.retryFailedRun).toHaveBeenCalledTimes(1);
  });

  it("does not navigate back after AgentDetail has unmounted", async () => {
    const oldRetry = deferred<{ runId: string; issueId: null }>();
    agentsApiMock.retryFailedRun.mockReturnValue(oldRetry.promise);
    const router = makeRouter();
    await renderRouter(router);
    await clickRetry();
    await act(async () => { await router.navigate("/outside"); });
    expect(container.textContent).toContain("Outside agent detail");
    await act(async () => { oldRetry.resolve({ runId: "old-successor", issueId: null }); });
    await flush();
    expect(router.state.location.pathname).toBe("/outside");
  });

  it("does not carry feedback or late success across companies", async () => {
    const oldRetry = deferred<{ runId: string; issueId: null }>();
    agentsApiMock.get.mockImplementation(async (_ref: string, companyId: string) => companyId === "company-2" ? otherCompanyAgent : agent);
    heartbeatsApiMock.list.mockImplementation(async (companyId: string) => companyId === "company-2" ? [otherCompanyRun] : [run]);
    heartbeatsApiMock.get.mockImplementation(async (requestedRunId: string) => requestedRunId === otherRunId ? otherCompanyRun : run);
    agentsApiMock.retryFailedRun.mockReturnValue(oldRetry.promise);
    const router = makeRouter(`/PAP/agents/maya/runs/${runId}`);
    await renderRouter(router);
    await clickRetry();
    await act(async () => { await router.navigate(`/BBB/agents/maya/runs/${otherRunId}`); });
    await waitFor(() => expect(container.textContent).toContain("Maya BBB"));
    await act(async () => { oldRetry.resolve({ runId: "old-successor", issueId: null }); });
    await flush();
    expect(router.state.location.pathname).toBe(`/BBB/agents/maya/runs/${otherRunId}`);
    expect(container.textContent).not.toContain("old-successor");
  });

  it("defers same-agent queued success through canonical loading, then navigates once identity is known", async () => {
    const slug = deferred<AgentRecord>();
    const queued = deferred<{ runId: null; issueId: string }>();
    agentsApiMock.get.mockImplementation((ref: string) => ref === "maya" ? slug.promise : Promise.resolve(agent));
    agentsApiMock.retryFailedRun.mockReturnValue(queued.promise);
    const router = makeRouter();
    await renderRouter(router);
    await clickRetry();
    await act(async () => { navigation.holdCanonical = false; navigation.queued.shift()?.(); });
    await waitFor(() => expect(agentsApiMock.get).toHaveBeenCalledWith("maya", "company-1"));
    await act(async () => { queued.resolve({ runId: null, issueId: "issue-1" }); });
    await flush();
    expect(router.state.location.pathname).toBe(`/PAP/agents/maya/runs/${runId}`);
    await act(async () => { slug.resolve(agent); });
    await waitFor(() => expect(router.state.location.pathname).toBe("/PAP/issues/issue-1"));
    expect(agentsApiMock.retryFailedRun).toHaveBeenCalledTimes(1);
  });
});
