import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_TURN_TEXT_BYTES, prepareTurnTextPayload } from "./turn-text-transfer.js";

describe("durable turn text transfer", () => {
  it("keeps a long quoted Unicode model envelope inside the unchanged wire bound", () => {
    const text = JSON.stringify({ task: { prompt: '履歴\n"saved result"'.repeat(35000) } });
    const payload = { text, turnId: "turn-fixed", effort: "high" };
    expect(Buffer.byteLength(JSON.stringify({ payload }))).toBeGreaterThan(522240);
    const encoded = prepareTurnTextPayload("turn.start", payload);
    expect(Buffer.byteLength(JSON.stringify({ payload: encoded }))).toBeLessThan(522240);
    const transfer = encoded.textTransfer as { encoding: string; data: string; bytes: number; sha256: string };
    const restored = gunzipSync(Buffer.from(transfer.data, "base64"));
    expect(restored.toString("utf8")).toBe(text);
    expect(transfer.bytes).toBe(restored.length);
    expect(transfer.sha256).toBe(createHash("sha256").update(restored).digest("hex"));
    expect(encoded).toMatchObject({ turnId: "turn-fixed", effort: "high" });
    expect(encoded).not.toHaveProperty("text");
    expect(payload.text).toBe(text);
  });
  it("keeps short and unrelated payloads unchanged", () => {
    const value = { text: "plain" };
    expect(prepareTurnTextPayload("turn.start", value)).toBe(value);
    expect(prepareTurnTextPayload("semantic_tool.result", value)).toBe(value);
  });
  it("covers steering and refuses transport injection or oversized text", () => {
    expect(prepareTurnTextPayload("turn.steer", { text: "x".repeat(200000) })).toHaveProperty("textTransfer");
    expect(() => prepareTurnTextPayload("turn.start", { textTransfer: {} })).toThrow("transport-owned");
    expect(() => prepareTurnTextPayload("turn.start", { text: "x".repeat(MAX_TURN_TEXT_BYTES + 1) })).toThrow("transfer limit");
    expect(() => prepareTurnTextPayload("turn.start", { text: "x".repeat(200000) + String.fromCharCode(0xd800) })).toThrow("Unicode");
  });
});
