import { expect, test } from "vitest";

import { parseBoundedWebResult } from "./bounded-output.js";

const init = { type: "system", subtype: "init", session_id: "cli-session" };
const use = { type: "tool_use", name: "web_search", input: { query: "public source" } };
const success = { type: "tool_result", name: "web_search", is_error: false,
  output: JSON.stringify({ success: true, data: { web: [{ url: "https://example.org/source" }] } }) };
const final = { type: "result", session_id: "cli-session", exit_code: 0, text: "Finding with source." };
const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

test("accepts actual CLI evidence and returns only the final answer", () => {
  expect(parseBoundedWebResult(lines(init, use, success, final), { requireText: true })).toEqual({
    sessionId: "cli-session", text: "Finding with source.", searches: 1,
    sourceUrls: ["https://example.org/source"],
  });
  expect(parseBoundedWebResult(lines(init, use, success, use, success, final), { requireText: true })?.searches).toBe(2);
  expect(parseBoundedWebResult(lines(init, use, success, use, success, final), { exactlyOneSearch: true })).toBeNull();
});

test("rejects missing, failed, spoofed, or incomplete web evidence", () => {
  const failure = { ...success, is_error: true };
  const privateUrl = { ...success, output: JSON.stringify({ success: true, data: { web: [{ url: "http://127.0.0.1/" }] } }) };
  const otherTool = { ...use, name: "web_extract" };
  const wrongSession = { ...final, session_id: "other" };
  const noText = { ...final, text: "" };
  for (const output of [
    lines(init, final), lines(init, use, failure, final), lines(init, use, privateUrl, final),
    lines(init, otherTool, success, final), lines(init, use, success, wrongSession),
    lines(init, use, success, noText), lines(init, use, success, final, use),
    "Model prose only\n", lines(init, use, final),
  ]) expect(parseBoundedWebResult(output, { requireText: true })).toBeNull();
});
