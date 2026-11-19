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
    // WindowControls renders a plain flex container: the three buttons are
    // labelled through the shared catalog ("最小化" / "最大化" / "关闭窗口"),
    // but the container itself has no role/accessible name, so scope by class.
    const controls = page.locator(".window-controls");
    await expect(controls).toBeVisible();
    // Dragging is routed by Tauri's `data-tauri-drag-region` handler: the header
    // opts its whole subtree in with "deep", while the workspace picker and the
    // window buttons opt out with "false". CSS `-webkit-app-region` only carves
    // out the no-drag islands.
    await expect(page.locator(".topbar")).toHaveAttribute(
      "data-tauri-drag-region",
      "deep",
    );
    await expect(page.locator(".topbar .connection-picker")).toHaveAttribute(
      "data-tauri-drag-region",
      "false",
    );
    await expect(page.locator(".topbar .connection")).toHaveCSS(
      "app-region",
      "no-drag",
    );
    await expect(controls).toHaveAttribute("data-tauri-drag-region", "false");
    await expect(controls).toHaveCSS("app-region", "no-drag");
    await expect(controls.getByRole("button")).toHaveCount(3);
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
    // Closing goes through the guarded-close command so unsaved work can prompt;
    // it no longer calls `plugin:window|close` directly.
    expect(calls).toEqual(
      expect.arrayContaining([
        "plugin:window|minimize",
        "plugin:window|toggle_maximize",
        "close_guard_request",
      ]),
    );
    await page
      .locator(".topbar")
      .screenshot({ path: test.info().outputPath("custom-titlebar.png") });
  });
}
