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
  await expect(page.locator(".file-workbench .file-table")).toBeVisible();
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
  // The footer's operations entry is the P4 task panel now. Finished operations
  // leave no row behind, so a settled manual status read shows the idle state
  // both on the trigger and inside the task list it opens.
  const operations = page.locator(".p4-status");
  await expect(operations).toHaveText(/P4 idle/);
  await operations.click();
  const tasks = page.getByRole("dialog", { name: "P4 tasks" });
  await expect(tasks).toBeVisible();
  await expect(tasks.locator(".task-idle")).toHaveText("P4 idle");
});
