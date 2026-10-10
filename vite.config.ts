import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  test: {
    exclude: [
      ...configDefaults.exclude,
      "scripts/release-config.test.mjs",
      "scripts/ci-step-result.test.mjs",
    ],
  },
  build: {
    rollupOptions: {
      output: { manualChunks: { docking: ["dockview-react"] } },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
