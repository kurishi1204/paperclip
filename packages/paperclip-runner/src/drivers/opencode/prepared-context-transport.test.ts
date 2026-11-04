import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessSession } from "../../contracts/harness-driver.js";

import {
  OpenCodeServerDriver,
} from "./opencode-server-driver.js";

const fixture = resolve("test/fixtures/fake-opencode-server.mjs");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("prepared OpenCode context transport", () => {
  it("sends prepared initial prompts without the proxy task envelope", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-prepared-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-prepared-workspace-"),
    );
    roots.push(root, workspace);
    const submitted: Record<string, unknown>[] = [];
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      conversationMode: "prepared",
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
      fetch: async (input, init) => {
        if (String(input).endsWith("/prompt_async"))
          submitted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return fetch(input, init);
      },
    });

    // This exercises two real fixture processes, two turns, recovery and close.
    // The default 5s unit-test budget can expire during valid startup/cleanup.
    const openSessions = new Set<HarnessSession>();
    try {
      const session = await driver.openSession({
        runId: "run-prepared-opencode",
        normalizedSessionId: "prepared-opencode",
        workingDirectory: workspace,
      });
      openSessions.add(session);
      await session.startTurn({
        message: { role: "user", text: "prepared OpenCode initial wake" },
      });
      let initialCompleted = false;
      for await (const event of session.events()) {
        if (event.eventType === "turn.completed") { initialCompleted = true; break; }
      }
      expect(initialCompleted).toBe(true);
      const snapshot = await session.snapshot();
      await session.close({ reason: "prepared-test" });
      openSessions.delete(session);
      const recovered = await driver.recoverSession?.(snapshot);
      expect(recovered?.recovered).toBe(true);
      const continued = recovered!.session!;
      openSessions.add(continued);
      await continued.startTurn({
        message: { role: "user", text: "completion-only OpenCode continuation" },
      });
      let continuationCompleted = false;
      for await (const event of continued.events()) {
        if (event.eventType === "turn.completed") { continuationCompleted = true; break; }
      }
      expect(continuationCompleted).toBe(true);
      expect(submitted.map((body) => body.parts)).toEqual([
        [{ type: "text", text: "prepared OpenCode initial wake" }],
        [{ type: "text", text: "completion-only OpenCode continuation" }],
      ]);
      expect(JSON.stringify(submitted)).not.toContain('"task"');
    } finally {
      await Promise.all([...openSessions].map((session) =>
        session.close({ reason: "prepared-test-cleanup" }),
      ));
    }
  }, 30_000);
});
