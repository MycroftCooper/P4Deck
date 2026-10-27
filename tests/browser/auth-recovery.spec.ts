import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`expired Pending tickets have a recovery path and recover after external login at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.leftOpen", "false");
    });
    await page.goto("/#/files");
    await expect(page.locator(".file-workbench h1")).toBeVisible();
    await page.evaluate(async () => {
      const path = "/src/infrastructure/backend/index.ts";
      const { backend } = await import(path);
      const runtime = await backend.runtimeInfo();
      const connected = {
        ...runtime.connection,
        state: "connected",
        recovery: "none",
      };
      const readPending = backend.queryPendingChanges.bind(backend);
      const state = { expired: true };
      backend.queryPendingChanges = async (...args: unknown[]) => {
        if (state.expired)
          throw 'p4 changes {"code0":805575992,"data":"Your session has expired, please login again."}';
        return readPending(...args);
      };
      backend.queryLoginStatus = async () =>
        state.expired
          ? {
              ...connected,
              state: "ticketExpired",
              errorCode: "ticketExpired",
              recovery: "login",
            }
          : connected;
      Object.assign(window, { authRecovery: state });
    });
    const activity = page.getByRole("navigation", { name: "Activity bar" });
    await activity.getByRole("button", { name: /^Pending/ }).click();
    const alert = page.locator(".pending-page [role=alert]");
    await expect(alert).toContainText("Sign in again in connection settings");
    await expect(alert).not.toContainText("code0");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page
      .getByRole("button", { name: "Connection settings", exact: true })
      .click();
    await expect(page.locator(".connection-status-card")).toContainText(
      "Login ticket expired",
    );
    await page.screenshot({
      path: testInfo.outputPath("expired-login-recovery.png"),
    });
    await page.evaluate(() => {
      (window as any).authRecovery.expired = false;
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.locator(".connection-status-card")).toContainText(
      "Connected and authenticated",
    );
    await activity.getByRole("button", { name: /^Pending/ }).click();
    await expect(page.locator('[data-pending-change="0"]')).toBeVisible();
    await expect(alert).toHaveCount(0);
  });
}
