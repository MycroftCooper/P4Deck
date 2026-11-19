import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`settings stack saved connections and align notification controls at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem("p4deck.locale", "zh-CN");
      localStorage.setItem("p4deck.leftOpen", "false");
      localStorage.setItem(
        "p4deck.ui",
        JSON.stringify({ activityBarText: false }),
      );
    });
    await page.goto("/#/settings");
    const connections = page.locator(".connection-profiles-card");
    await expect(
      connections.locator(".profile-list-item").first(),
    ).toBeVisible();
    const list = (await connections
      .locator(".profile-list-panel")
      .boundingBox())!;
    const editor = (await connections
      .locator(".profile-editor")
      .boundingBox())!;
    expect(editor.y).toBeGreaterThanOrEqual(list.y + list.height);
    expect(Math.abs(editor.x - list.x)).toBeLessThan(1);
    expect(Math.abs(editor.width - list.width)).toBeLessThan(1);
    const tools = (await connections
      .locator(".profile-list-tools")
      .boundingBox())!;
    const search = (await connections
      .locator(".profile-search")
      .boundingBox())!;
    expect(search.width).toBeGreaterThan(tools.width * 0.6);
    await connections.screenshot({
      path: test.info().outputPath("saved-connections.png"),
    });

    // The "刷新与通知" heading belongs to the collapsible SettingsSection, not to
    // the card inside it, so anchor on the section by its stable id.
    const refresh = page.locator('[data-settings-section="refresh"]');
    await refresh.scrollIntoViewIfNeeded();
    // The section now holds two number inputs; the interval is the first one.
    const interval = (await refresh
      .getByRole("spinbutton")
      .first()
      .boundingBox())!;
    const notifications = (await refresh
      .getByRole("combobox", { name: "桌面通知", exact: true })
      .boundingBox())!;
    const scope = (await refresh
      .getByRole("combobox", { name: "通知范围", exact: true })
      .boundingBox())!;
    // Compare the bell icon with the label that actually contains it.
    const label = (await refresh
      .locator(".settings-field-label:has(svg)")
      .boundingBox())!;
    const icon = (await refresh
      .locator(".settings-field-label svg")
      .boundingBox())!;
    expect(
      Math.abs(icon.y + icon.height / 2 - label.y - label.height / 2),
    ).toBeLessThan(1);
    if (width === 1280) {
      // The refresh grid has three columns, so interval + threshold +
      // notifications share the first row while the scope select wraps below.
      expect(Math.abs(interval.y - notifications.y)).toBeLessThan(1);
      expect(scope.y).toBeGreaterThan(interval.y + interval.height);
    } else {
      expect(notifications.y).toBeGreaterThan(interval.y + interval.height);
      expect(scope.y).toBeGreaterThan(notifications.y + notifications.height);
    }
    const overflow = await page
      .locator(".settings-page")
      .evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await refresh.screenshot({
      path: test.info().outputPath("refresh-notifications.png"),
    });
  });
}
