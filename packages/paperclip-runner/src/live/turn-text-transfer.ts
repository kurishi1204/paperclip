import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const MAX_TURN_TEXT_BYTES = 1024 * 1024;
const COMPRESS_FROM_BYTES = 128 * 1024;

/** Keep the durable command/frame bounds; transfer the exact text, never a summary. */
export function prepareTurnTextPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (type !== "turn.start" && type !== "turn.steer") return payload;
  if (Object.hasOwn(payload, "textTransfer")) throw new Error("turn text transfer is transport-owned");
  if (typeof payload.text !== "string") return payload;
  const bytes = Buffer.from(payload.text, "utf8");
  if (bytes.length > MAX_TURN_TEXT_BYTES) throw new Error("turn text exceeds the transfer limit");
  if (bytes.length < COMPRESS_FROM_BYTES) return payload;
  if (bytes.toString("utf8") !== payload.text) throw new Error("turn text must be valid Unicode");
  const compressed = gzipSync(bytes);
  const textTransfer = {
    encoding: "gzip-base64.v1",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    data: compressed.toString("base64"),
  };
  const { text: _text, ...rest } = payload;
  const encoded = { ...rest, textTransfer };
  // Incompressible input still goes through the existing command size check.
  // Never silently send a larger form or change the provider's input.
  return Buffer.byteLength(JSON.stringify(encoded)) < Buffer.byteLength(JSON.stringify(payload)) ? encoded : payload;
}
