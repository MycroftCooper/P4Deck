import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  // Browser tests and the desktop watcher may run together.
  cacheDir:
    mode === "desktop" ? "node_modules/.vite-desktop" : "node_modules/.vite",
  // Native desktop builds compile the browser mock backend out of the bundle.
  // `true` for dev server + build in desktop mode, `false` for browser/vitest.
  define: { __P4DECK_DESKTOP__: JSON.stringify(mode === "desktop") },
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
  // dockview-react only appears behind a lazy route, so pre-bundle it explicitly
  // instead of letting the dev server re-optimize (and reload) on first use.
  optimizeDeps: { entries: ["index.html"], include: ["dockview-react"] },
  clearScreen: false,
  test: {
    setupFiles: ["src/testSetup.ts"],
    exclude: [
      ...configDefaults.exclude,
      "scripts/ci-step-result.test.mjs",
      "scripts/theme-contrast.test.mjs",
      "scripts/validate-versions.test.mjs",
      "tests/browser/**",
      // artifacts/evidence 会收进候选 overlay（含 *.test.tsx 源文件快照），不能被当成真实测试执行。
      "artifacts/**",
      ".local/**",
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
