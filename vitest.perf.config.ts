import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["scripts/performance/**/*.perf.tsx"],
    environment: "jsdom",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
