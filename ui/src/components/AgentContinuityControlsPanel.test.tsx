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
  heartbeatEnabled: false, canAssignTasks: false, canCreateAgents: false,
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
    expect(container.textContent).toContain("Saving does not resume or wake the agent");
  });
});
