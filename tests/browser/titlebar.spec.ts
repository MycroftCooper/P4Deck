import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`native titlebar controls fit beside the workspace picker at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.ui", JSON.stringify({ autoRefresh: false }));
    });
    await page.goto("/#/files");
    await expect(page.locator(".topbar .connection")).toBeVisible();
    await page.evaluate(async () => {
      // Keep the browser backend, and mock only native window IPC.
      const mocksPath = "/node_modules/@tauri-apps/api/mocks.js";
      const { mockIPC, mockWindows } = await import(mocksPath);
      const calls: string[] = [];
      mockWindows("main");
      mockIPC(
        (command: string) => {
          calls.push(command);
          if (command === "plugin:window|is_maximized") return false;
        },
        { shouldMockEvents: true },
      );
      Object.assign(window, { isTauri: true, titlebarCalls: calls });
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "p4deck.locale",
          newValue: "zh-CN",
        }),
      );
    });
    const controls = page.getByRole("group", { name: "窗口控制" });
    await expect(controls).toBeVisible();
    await expect(page.locator(".topbar")).toHaveCSS("app-region", "drag");
    await expect(page.locator(".topbar .connection")).toHaveCSS(
      "app-region",
      "no-drag",
    );
    await expect(controls).toHaveCSS("app-region", "no-drag");
    await expect(page.locator("[data-tauri-drag-region]")).toHaveCount(0);
    const picker = (await page.locator(".topbar .connection").boundingBox())!;
    const buttons = (await controls.boundingBox())!;
    expect(buttons.x).toBeGreaterThanOrEqual(picker.x + picker.width);
    expect(buttons.x + buttons.width).toBe(width);
    expect(buttons.y).toBe(0);
    for (const name of ["最小化", "最大化", "关闭窗口"]) {
      await controls.getByRole("button", { name, exact: true }).click();
    }
    const calls = await page.evaluate(
      () => (window as unknown as { titlebarCalls: string[] }).titlebarCalls,
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        "plugin:window|minimize",
        "plugin:window|toggle_maximize",
        "plugin:window|close",
      ]),
    );
    await page
      .locator(".topbar")
      .screenshot({ path: test.info().outputPath("custom-titlebar.png") });
  });
}
