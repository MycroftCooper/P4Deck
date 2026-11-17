import { defineConfig, devices } from "@playwright/test";

const requestedChannel = process.env.P4DECK_BROWSER_CHANNEL?.trim() || "msedge";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  // Each worker starts a desktop browser; bound concurrency on developer PCs.
  workers: 2,
  retries: 0,
  reporter: "list",
  // The dev server cold-starts Vite and the mock backend; under load a page can
  // take several seconds to paint, so a 5s default assertion timeout reported
  // slow boots as failures. Test-level timeouts stay generous for long flows.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  webServer: {
    command: "pnpm dev --host 127.0.0.1",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:1420",
    channel: requestedChannel === "bundled" ? undefined : requestedChannel,
    viewport: { width: 390, height: 844 },
    trace: "retain-on-failure",
  },
});
