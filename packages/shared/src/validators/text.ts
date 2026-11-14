import { z } from "zod";

// Legacy opt-in conversion for callers that explicitly own an escaped input.
// Never apply this to arbitrary text accepted by an API storage schema.
export function normalizeEscapedLineBreaks(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

// HTTP JSON decoding has already happened. Literal escapes in Markdown, code,
// JSON and paths are content, not a second transport encoding to guess at.
// Keep actual LF/CRLF and literal backslashes unchanged; callers retain their
// existing explicit trim/length/optional constraints.
export const multilineTextSchema = z.string();
