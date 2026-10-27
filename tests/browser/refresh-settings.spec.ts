import { expect, test } from "@playwright/test";

test("refresh interval persists, zero disables it, and quick pause remembers custom minutes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.addInitScript(() =>
    localStorage.setItem("p4deck.locale", "en-US"),
  );
  await page.goto("/#/settings");
  const interval = page.getByRole("spinbutton", {
    name: "Auto-refresh interval (minutes)",
  });
  await expect(interval).toHaveValue("5");
  await interval.fill("12");
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("p4deck.ui")!).autoRefreshMinutes,
      ),
    )
    .toBe(12);
  await page.reload();
  await expect(interval).toHaveValue("12");
  const toggle = page.locator(".auto-refresh-status");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(interval).toHaveValue("0");
  await toggle.click();
  await expect(interval).toHaveValue("12");
  await interval.fill("0");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(interval).toHaveValue("0");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await interval.fill("2");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("p4deck.ui")!).autoRefreshMinutes,
      ),
    )
    .toBe(2);
});
