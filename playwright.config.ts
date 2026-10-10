import { defineConfig, devices } from "@playwright/test";

const requestedChannel = process.env.P4DECK_BROWSER_CHANNEL?.trim() || "msedge";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
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
