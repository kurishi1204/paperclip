import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildHermesConfig } from "./build-config.js";

function values(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return { model: "", thinkingEffort: "", extraArgs: "", maxTurnsPerRun: 0,
    ...overrides } as CreateConfigValues;
}

describe("Hermes canonical reasoning effort", () => {
  it("builds high as a typed field instead of a legacy extra argument", () => {
    const config = buildHermesConfig(values({ thinkingEffort: "high" }));
    expect(config).toMatchObject({ reasoningEffort: "high" });
    expect(config).not.toHaveProperty("extraArgs");
  });

  it("keeps a schema-only high choice and deduplicates equal top-level input", () => {
    for (const thinkingEffort of ["", "high"]) {
      expect(buildHermesConfig(values({ thinkingEffort, adapterSchemaValues: { reasoningEffort: "high" } })))
        .toMatchObject({ reasoningEffort: "high" });
    }
  });

  it("refuses conflicting choices instead of silently selecting a winner", () => {
    expect(() => buildHermesConfig(values({ thinkingEffort: "low", adapterSchemaValues: { reasoningEffort: "high" } })))
      .toThrow(/conflicts/);
  });

  it.each(["HIGH", "extreme", "--yolo", 7])("rejects invalid builder inputs %s on both paths", (raw) => {
    expect(() => buildHermesConfig(values({ thinkingEffort: raw as string }))).toThrow(/reasoningEffort/);
    expect(() => buildHermesConfig(values({ adapterSchemaValues: { reasoningEffort: raw } }))).toThrow(/reasoningEffort/);
  });

  it("preserves unset defaults, unrelated fields and user-entered extra arguments", () => {
    const input = values({ model: "gpt-6.1-sol", maxTurnsPerRun: 2, extraArgs: "--source own-fixture" });
    const before = buildHermesConfig(input);
    const empty = buildHermesConfig({ ...input, adapterSchemaValues: { reasoningEffort: "" } });
    expect(empty).toEqual(before);
    expect(before).not.toHaveProperty("reasoningEffort");
    expect(before).toMatchObject({ model: "gpt-6.1-sol", maxTurnsPerRun: 2,
      persistSession: true, extraArgs: ["--source", "own-fixture"] });
    expect(buildHermesConfig({ ...input, thinkingEffort: "high" }).extraArgs).toEqual(before.extraArgs);
  });
});
