// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import type { AdapterConfigFieldsProps } from "../types";
import { buildHermesConfig } from "@paperclipai/hermes-paperclip-adapter/ui";
import { getConfigSchema } from "../../../../packages/adapters/hermes/src/server/config-schema";
import { getUIAdapter, syncExternalAdapters } from "../registry";
import { SchemaConfigFields, invalidateConfigSchemaCache } from "../schema-config-fields";
import { defaultCreateValues } from "../../components/agent-config-defaults";
import { buildAgentUpdatePatch, type AgentConfigOverlay } from "../../lib/agent-config-patch";
import { TooltipProvider } from "../../components/ui/tooltip";

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  invalidateConfigSchemaCache("hermes_local");
  syncExternalAdapters([]);
  vi.unstubAllGlobals();
});

async function selectHigh(overrides: Partial<AdapterConfigFieldsProps> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => getConfigSchema() })));
  const mark = vi.fn();
  const set = vi.fn();
  const props: AdapterConfigFieldsProps = {
    mode: "edit", isCreate: false, adapterType: "hermes_local", section: "configuration",
    values: null, set, config: {}, eff: (_group, _field, original) => original,
    mark, models: [], ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<TooltipProvider><SchemaConfigFields {...props} /></TooltipProvider>));
  expect(container.textContent).toContain("Reasoning effort");
  const trigger = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Hermes default");
  expect(trigger).toBeTruthy();
  await act(async () => { trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const high = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "high");
  expect(high).toBeTruthy();
  await act(async () => { high?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  return { mark, set };
}

it("retains the Hermes builder through the registry and external parser override", () => {
  expect(getUIAdapter("hermes_local").buildAdapterConfig).toBe(buildHermesConfig);
  syncExternalAdapters([{ type: "hermes_local", label: "Synthetic parser override" }]);
  expect(getUIAdapter("hermes_local").buildAdapterConfig).toBe(buildHermesConfig);
});

it("selects canonical high in edit mode and preserves it in the save patch", async () => {
  const { mark } = await selectHigh();
  expect(mark).toHaveBeenCalledWith("adapterConfig", "reasoningEffort", "high");
  const overlay: AgentConfigOverlay = { identity: {}, adapterConfig: {}, heartbeat: {}, debug: {}, runtime: {} };
  for (const [group, field, value] of mark.mock.calls) {
    expect(group).toBe("adapterConfig");
    overlay.adapterConfig[field] = value;
  }
  // The pure patch builder reads only these fields from this synthetic agent.
  const agent = { adapterConfig: { model: "gpt-6.1-sol", provider: "openai-codex" }, runtimeConfig: {} } as unknown as Agent;
  expect(buildAgentUpdatePatch(agent, overlay)).toMatchObject({ replaceAdapterConfig: true,
    adapterConfig: { model: "gpt-6.1-sol", provider: "openai-codex", reasoningEffort: "high" } });
  expect(overlay.adapterConfig).not.toHaveProperty("effort");
});

it("preserves the default and translates create-mode schema high into the typed config", async () => {
  const { set } = await selectHigh({ mode: "create", isCreate: true,
    values: { ...defaultCreateValues, model: "gpt-6.1-sol", adapterSchemaValues: {} } });
  const beforeChoice = set.mock.calls.slice(0, -1);
  expect(beforeChoice.every(([patch]) => !patch.adapterSchemaValues?.reasoningEffort)).toBe(true);
  const choice = set.mock.calls.at(-1)?.[0];
  expect(choice.adapterSchemaValues.reasoningEffort).toBe("high");
  const config = getUIAdapter("hermes_local").buildAdapterConfig({ ...defaultCreateValues, ...choice });
  expect(config.reasoningEffort).toBe("high");
  expect(config).not.toHaveProperty("extraArgs");
});
