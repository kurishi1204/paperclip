// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentContinuityControls } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentContinuityControlsPanel } from "./AgentContinuityControlsPanel";

const getControls = vi.hoisted(() => vi.fn());
const patchControls = vi.hoisted(() => vi.fn());
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({
  agentsApi: { getContinuityControls: getControls, patchContinuityControls: patchControls },
}));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial: AgentContinuityControls = {
  id: "agent-1", companyId: "company-1", status: "paused", role: "engineer",
  adapterType: "codex_local", updatedAt: "2026-10-13T00:00:00.000001Z",
  assignmentMode: "protected", blockAssignment: true, wakeOnDemand: false,
  heartbeatEnabled: false, canAssignTasks: false, canCreateAgents: false, eligible: true, canManage: true,
};

async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("AgentContinuityControlsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getControls.mockResolvedValue(initial);
    patchControls.mockResolvedValue({ ...initial, wakeOnDemand: true, updatedAt: "2026-10-13T00:00:00.000002Z" });
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("saves both scoped flags with the exact read revision and no general agent update", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const routeDetailKey = ["agents", "detail", "paused-worker", "company-1"];
    const aliasDetailKey = ["agents", "detail", "legacy-paused-worker", "company-1"];
    queryClient.setQueryData(routeDetailKey, { name: "Paused worker" });
    queryClient.setQueryData(aliasDetailKey, { name: "Paused worker" });
    root = createRoot(container);
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <AgentContinuityControlsPanel agentId="agent-1" companyId="company-1" />
      </QueryClientProvider>,
    ));
    await flush();
    const wake = container.querySelector<HTMLButtonElement>('[aria-label="Wake on demand"]');
    expect(wake?.getAttribute("aria-checked")).toBe("false");
    await act(async () => wake?.click());
    const save = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Save continuity controls"));
    expect(save?.disabled).toBe(false);
    await act(async () => save?.click());
    await flush();
    expect(getControls).toHaveBeenCalledWith("agent-1", "company-1");
    expect(patchControls).toHaveBeenCalledExactlyOnceWith("agent-1", {
      expectedUpdatedAt: initial.updatedAt, blockAssignment: true, wakeOnDemand: true,
    }, "company-1");
    expect(queryClient.getQueryState(routeDetailKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(aliasDetailKey)?.isInvalidated).toBe(true);
    expect(container.textContent).toContain("Saving does not resume or wake the agent");
  });

  it("keeps eligible controls read-only without management permission", async () => {
    getControls.mockResolvedValue({ ...initial, canManage: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <AgentContinuityControlsPanel agentId="agent-1" companyId="company-1" />
    </QueryClientProvider>));
    await flush();
    expect(container.textContent).toContain("Read-only");
    expect(container.querySelector('[aria-label="Wake on demand"]')?.getAttribute("disabled")).not.toBeNull();
    const save = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Save continuity controls"));
    expect(save?.disabled).toBe(true);
    expect(patchControls).not.toHaveBeenCalled();
  });

  it("does not offer Save when the server marks the agent ineligible", async () => {
    getControls.mockResolvedValue({ ...initial, eligible: false });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <AgentContinuityControlsPanel agentId="agent-1" companyId="company-1" />
      </QueryClientProvider>,
    ));
    await flush();
    expect(container.textContent).toContain("not eligible for scoped continuity changes");
    expect(container.querySelector('[aria-label="Wake on demand"]')).toBeNull();
    expect(patchControls).not.toHaveBeenCalled();
  });

  it("preserves a dirty draft and its original revision on a background refresh", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <AgentContinuityControlsPanel agentId="agent-1" companyId="company-1" />
      </QueryClientProvider>,
    ));
    await flush();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Wake on demand"]')?.click());
    await act(async () => queryClient.setQueryData(
      ["agents", "agent-1", "continuity-controls"],
      { ...initial, updatedAt: "2026-10-13T00:00:00.000002Z" },
    ));
    await flush();
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Wake on demand"]')?.getAttribute("aria-checked"))
      .toBe("true");
    expect(container.textContent).toContain("Your choices are preserved");
    const save = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Save continuity controls"));
    expect(save?.disabled).toBe(true);
    expect(patchControls).not.toHaveBeenCalled();
    const reload = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Reload continuity controls"));
    await act(async () => reload?.click());
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Wake on demand"]')?.getAttribute("aria-checked"))
      .toBe("false");
    expect(container.textContent).not.toContain("Your choices are preserved");
  });
  it("blocks scoped saves while configuration edits or their save are pending", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    const render = (configurationBusy: boolean) => root.render(<QueryClientProvider client={client}>
      <AgentContinuityControlsPanel agentId="agent-1" companyId="company-1" configurationBusy={configurationBusy} />
    </QueryClientProvider>);
    await act(async () => render(true));
    await flush();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Wake on demand"]')?.click());
    const save = () => Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Save continuity controls"));
    expect(save()?.disabled).toBe(true);
    await act(async () => save()?.click());
    expect(patchControls).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Save or discard configuration edits");
    await act(async () => render(false));
    expect(save()?.disabled).toBe(false);
    expect(container.querySelector('[aria-label="Wake on demand"]')?.getAttribute("aria-checked")).toBe("true");
    await act(async () => save()?.click());
    await flush();
    expect(patchControls).toHaveBeenCalledTimes(1);
  });

  it("recovers a failed read through an explicit retry", async () => {
    getControls.mockRejectedValueOnce(new Error("temporary outage"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <AgentContinuityControlsPanel agentId="agent-1" companyId="company-1" />
    </QueryClientProvider>));
    await flush();
    const retry = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Retry reading controls"));
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    await flush();
    expect(getControls).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Could not read these controls");
    expect(container.querySelector('[aria-label="Wake on demand"]')).not.toBeNull();
  });

});
