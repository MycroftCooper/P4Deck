import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Same compile-time switch as vite.config.ts: the perf harness runs the
  // browser mock backend, never the desktop adapter.
  define: { __P4DECK_DESKTOP__: "false" },
  plugins: [react()],
  test: {
    include: ["scripts/*.perf.tsx"],
    environment: "jsdom",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
