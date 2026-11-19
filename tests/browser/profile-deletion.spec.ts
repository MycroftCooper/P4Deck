import { expect, test } from "@playwright/test";

test("sole current connection can be deleted after confirmation and clears data views", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "zh-CN");
    localStorage.setItem("p4deck.leftOpen", "false");
  });
  await page.goto("/#/pending");
  await expect(page.locator("[data-pending-change]").first()).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const remove = page.locator(".profile-delete");
  await expect(remove).toHaveCount(1);
  await expect(remove).toBeEnabled();
  await remove.click();
  const confirm = page.getByRole("dialog", { name: "确认删除已保存连接？" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("断开连接");
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(remove).toHaveCount(1);
  await remove.click();
  await confirm.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.locator(".profile-list-item")).toHaveCount(0);
  // Nothing is left to activate, so the app falls back to the connection setup
  // guide instead of keeping stale data views mounted.
  const gate = page.getByRole("dialog", { name: "请先配置 P4" });
  await expect(gate).toBeVisible();
  await expect(page.locator(".connection-setup")).toBeVisible();
  await expect(page.locator(".main-stage")).toHaveCount(0);
  await expect(page.locator("[data-pending-change]")).toHaveCount(0);
  await gate.getByRole("button", { name: "去配置 P4", exact: true }).click();
  await expect(page.locator(".profile-list-empty")).toContainText(
    "尚无已保存连接",
  );
  await expect(
    page.getByRole("button", { name: "新建", exact: true }).first(),
  ).toBeEnabled();
});
