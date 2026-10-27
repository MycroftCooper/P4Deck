import { expect, test } from "@playwright/test";

test("toolbar Refresh forces a fresh workspace status read even without a selected file", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "false");
    localStorage.setItem("p4deck.ui", JSON.stringify({ autoRefresh: false }));
  });
  await page.goto("/#/files");
  await expect(page.locator(".file-workbench h1")).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(path);
    const original = backend.listWorkspaceChildren.bind(backend);
    const state = {
      reads: [] as Array<{ refresh: boolean; localOnly: boolean }>,
      releases: [] as Array<() => void>,
    };
    Object.assign(window, { manualStatusReads: state });
    backend.listWorkspaceChildren = async (...args: any[]) => {
      const refresh = args[1] === true;
      const localOnly = args[3] === true;
      state.reads.push({ refresh, localOnly });
      if (refresh)
        await new Promise<void>((resolve) => state.releases.push(resolve));
      return original(...args);
    };
  });
  await page
    .getByRole("toolbar", { name: "Object actions" })
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const reads = (window as any).manualStatusReads.reads as Array<{
          refresh: boolean;
          localOnly: boolean;
        }>;
        return (
          reads.some((read) => read.localOnly) &&
          reads.some((read) => read.refresh)
        );
      }),
    )
    .toBe(true);
  await page.evaluate(() => {
    for (const release of (window as any).manualStatusReads.releases) release();
  });
  await expect(
    page.getByRole("button", { name: "Operation completed, view operations" }),
  ).toBeVisible();
});
