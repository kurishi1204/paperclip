import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Darwin embedded-Postgres fixtures share one host-wide IPC lease.
    // Keep file execution serial so migration suites respect that ownership.
    fileParallelism: process.platform !== "darwin",
    include: ["src/**/*.test.ts"],
  },
});
