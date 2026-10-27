import { expect, test } from "@playwright/test";

test("empty CL deletes with one click while nonempty CL stays protected", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("p4deck.locale", "en-US"),
  );
  await page.goto("/#/files");
  await expect(page.locator(".file-workbench h1")).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(path);
    const runtime = await backend.runtimeInfo();
    const changes = [223, 224].map((id) => ({
      id,
      description: "Delete fixture",
      user: runtime.context.user,
      client: runtime.context.client,
      status: "pending",
      jobs: [],
      shelvedFiles: [],
      files: id === 223 ? [] : [{ depotPath: "//depot/a.txt", action: "edit" }],
    }));
    backend.queryPendingChanges = async (query: any) => ({
      requestGeneration: query.requestGeneration,
      items: changes.slice(),
      hasMore: false,
      partial: false,
      stats: {
        scannedCount: changes.length,
        matchedCount: changes.length,
        truncatedBySafetyLimit: false,
      },
    });
    backend.mutatePendingChange = (request: any) => {
      Object.assign(window, {
        emptyDeleteRequest: request,
        emptyDeletePending: true,
      });
      return new Promise((resolve) => {
        Object.assign(window, {
          finishEmptyDelete: () => {
            changes.splice(
              changes.findIndex((item) => item.id === request.changeId),
              1,
            );
            Object.assign(window, { emptyDeletePending: false });
            resolve({
              operation: {
                operationId: request.operationId,
                exitCode: 0,
                durationMs: 1,
                events: [],
              },
              affectedChanges: [request.changeId],
              affectedPaths: [],
              refreshedChanges: [],
            });
          },
        });
      });
    };
  });
  await page
    .getByRole("navigation", { name: "Activity bar" })
    .getByRole("button", { name: /^Pending/ })
    .click();
  const empty = page.locator('[data-pending-change="223"]');
  const occupied = page.locator('[data-pending-change="224"]');
  await expect(
    occupied.getByRole("button", { name: "Delete", exact: true }),
  ).toBeDisabled();
  await empty.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(empty).toHaveCount(0);
  await expect(occupied).toBeVisible();
  expect(await page.evaluate(() => (window as any).emptyDeletePending)).toBe(
    true,
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).emptyDeleteRequest),
  ).toMatchObject({ type: "delete", changeId: 223 });
  await page.evaluate(() => (window as any).finishEmptyDelete());
  await expect
    .poll(() => page.evaluate(() => (window as any).emptyDeletePending))
    .toBe(false);
});
