import { describe, expect, it } from "vitest";
import { hasSelfTaskDocumentReplayHold, SELF_TASK_DOCUMENT_CONTEXT_KEY } from "../services/self-task-document-runtime.js";

describe("persisted document episode replay authority", () => {
  it("holds an unknown provider outcome even when no document receipt was recorded", () => {
    expect(hasSelfTaskDocumentReplayHold({ contextSnapshot: { [SELF_TASK_DOCUMENT_CONTEXT_KEY]: true } })).toBe(true);
  });
  it("does not derive replay permission from a result, a failure reason, or a current preference", () => {
    for (const contextSnapshot of [undefined, null, [], {}, { [SELF_TASK_DOCUMENT_CONTEXT_KEY]: false },
      { [SELF_TASK_DOCUMENT_CONTEXT_KEY]: "true" }, { selfTaskDocumentToolsOnly: true }]) {
      expect(hasSelfTaskDocumentReplayHold({ contextSnapshot })).toBe(false);
    }
    expect(hasSelfTaskDocumentReplayHold(null)).toBe(false);
  });
  it("distinguishes an ordinary server-stamped source from a held document source", () => {
    const held = { contextSnapshot: { [SELF_TASK_DOCUMENT_CONTEXT_KEY]: true } };
    const ordinary = { contextSnapshot: { [SELF_TASK_DOCUMENT_CONTEXT_KEY]: false } };
    expect(hasSelfTaskDocumentReplayHold(held)).toBe(true);
    expect(hasSelfTaskDocumentReplayHold(ordinary)).toBe(false);
    // This predicate never infers providerWorkStarted=false from a missing flag.
    // The existing admission/retry path must still prove its own safety.
  });
});
