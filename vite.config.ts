import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  // Browser tests and the desktop watcher may run together.
  cacheDir:
    mode === "desktop" ? "node_modules/.vite-desktop" : "node_modules/.vite",
  plugins: [
    react(),
    mode === "desktop" && {
      name: "desktop-dev-http-cache",
      apply: "serve",
      configureServer(server) {
        // WebView2 can retain an ETag whose cached body is unreadable. Vite's
        // early 304 path runs before response headers, so no-store alone cannot
        // recover those existing entries. Always send a body in desktop dev.
        server.middlewares.use((request, _response, next) => {
          delete request.headers["if-none-match"];
          delete request.headers["if-modified-since"];
          next();
        });
      },
    },
  ],
  // Do not crawl generated HTML under src-tauri/target during a cold start.
  optimizeDeps: { entries: ["index.html"] },
  clearScreen: false,
  test: {
    setupFiles: ["src/test/setupCache.ts"],
    exclude: [
      ...configDefaults.exclude,
      "scripts/release-config.test.mjs",
      "scripts/ci-step-result.test.mjs",
      "scripts/theme-contrast.test.mjs",
      "tests/browser/**",
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
    headers: mode === "desktop" ? { "Cache-Control": "no-store" } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
