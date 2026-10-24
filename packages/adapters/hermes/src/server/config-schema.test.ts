import { expect, it } from "vitest";
import { getConfigSchema } from "./config-schema.js";

it("offers an unset Hermes default and the CLI reasoning vocabulary", () => {
  expect(getConfigSchema().fields.find((field) => field.key === "reasoningEffort"))
    .toMatchObject({ type: "select", default: "", options: [
      { value: "", label: "Hermes default" },
      ...["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        .map((value) => ({ value, label: value })),
    ] });
});
