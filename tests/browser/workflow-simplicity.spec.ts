import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "false");
  });
  await page.goto("/#/files");
  await expect(page.locator(".file-workbench .file-table")).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(path);
    const runtime = await backend.runtimeInfo();
    const changes = [310, 320].map((id) => ({
      id,
      description: `Workflow ${id}`,
      user: runtime.context.user,
      client: runtime.context.client,
      status: "pending",
      jobs: [],
      shelvedFiles: [],
      files:
        id === 310
          ? [
              {
                depotPath: "//depot/simplicity.txt",
                clientPath: `//${runtime.context.client}/simplicity.txt`,
                action: "edit",
                state: "openedEdit",
              },
            ]
          : [],
    }));
    backend.queryPendingChanges = async (query: any) => ({
      requestGeneration: query.requestGeneration,
      items: structuredClone(changes),
      hasMore: false,
      partial: false,
      stats: {
        scannedCount: changes.length,
        matchedCount: changes.length,
        truncatedBySafetyLimit: false,
      },
    });
    backend.mutatePendingChange = async (request: any) => {
      Object.assign(window, { createRequest: request });
      const created = {
        ...changes[1],
        id: 330,
        description: request.description,
      };
      changes.push(created);
      return {
        operation: {
          operationId: request.operationId,
          exitCode: 0,
          durationMs: 1,
          events: [],
        },
        affectedChanges: [330],
        affectedPaths: [],
        refreshedChanges: [created],
      };
    };
    // A drop now dispatches through the selected-move host call; the separate
    // preflight/confirm pair this spec used to mock no longer exists.
    backend.selectedMoveExecute = async (request: any) => {
      Object.assign(window, { moveExecution: request });
      changes[1].files.push(changes[0].files.shift()!);
      return {
        execution: {
          schemaVersion: 1,
          payloadDigest: "a".repeat(64),
          revision: "1",
          executionState: "settled",
          outcome: "verified",
          dispatchState: "possible",
          recoveryRequired: false,
        },
        operationId: request.operationId,
        targetCreationUnknown: false,
        targetChangeId: 320,
        stage: "completed",
        files: request.files.map((file: any) => ({
          ...file,
          state: "moved" as const,
        })),
        message: "Moved file",
      };
    };
  });
  await page
    .locator(".activity-bar")
    .getByRole("button", { name: /^Pending/ })
    .click();
  await expect(page.locator('[data-pending-change="310"]')).toBeVisible();
}

test("new CL only needs its prefilled description and Create", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "New CL", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New changelist" });
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  await expect(dialog.getByRole("textbox")).toHaveValue("New changelist");
  await expect(dialog.getByText("Jobs", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-pending-change="330"]')).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).createRequest),
  ).toMatchObject({ type: "create", description: "New changelist", jobs: [] });
});

test("dropping into another CL moves immediately with no modal or layout banner", async ({
  page,
}) => {
  await setup(page);
  const source = page.locator('[data-pending-change="310"]').locator("..");
  const destination = page.locator('[data-pending-change="320"]').locator("..");
  await source.locator("header").click();
  const file = source.locator('.pending-file[draggable="true"]');
  await expect(file).toBeVisible();
  await page.evaluate(() => {
    Object.assign(window, { dialogsOpened: 0 });
    new MutationObserver((records) => {
      for (const record of records)
        for (const added of record.addedNodes)
          if (
            added instanceof Element &&
            (added.matches("dialog") || added.querySelector("dialog"))
          )
            (window as any).dialogsOpened++;
    }).observe(document.body, { childList: true, subtree: true });
  });
  const top = (await page.locator(".pending-query-bar").boundingBox())!.y;
  await file.dragTo(destination);
  await expect
    .poll(() => page.evaluate(() => !!(window as any).moveExecution))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as any).moveExecution))
    .toMatchObject({
      target: { kind: "existing", changeId: 320 },
      files: [{ depotPath: "//depot/simplicity.txt", sourceChangeId: 310 }],
    });
  expect(await page.evaluate(() => (window as any).dialogsOpened)).toBe(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(source.locator(".pending-file")).toHaveCount(0);
  // A successful drop auto-expands the destination changelist, so the moved row
  // is already visible without another toggle.
  await expect(destination.locator(".pending-body")).toBeVisible();
  await expect(destination.locator(".pending-file")).toHaveCount(1);
  expect((await page.locator(".pending-query-bar").boundingBox())!.y).toBe(top);
  await expect(page.locator(".pending-page > .workspace-notice")).toHaveCount(
    0,
  );
});

test("operation progress, completion and failure stay in the footer slot", async ({
  page,
}) => {
  await setup(page);
  // The old "view operations" button in the command toolbar is gone: operation
  // progress now lives in the footer's P4 status slot, and failures stay inside
  // that slot's task panel. Neither may move the toolbar or the Pending query
  // bar while an operation changes state.
  const status = page.locator(".p4-status");
  const center = page.locator(".command-center");
  const queryBar = page.locator(".pending-query-bar");
  const taskList = page.getByRole("dialog", { name: "P4 tasks" });
  await expect(status).toContainText("P4 idle");
  const centerHeight = (await center.boundingBox())!.height;
  const queryTop = (await queryBar.boundingBox())!.y;
  const idleStatusHeight = (await status.boundingBox())!.height;
  await page.clock.install({ time: new Date("2026-10-20T08:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-20T08:00:01Z"));
  const startCommand = (operationId: string) =>
    page.evaluate(async (id: string) => {
      const path = "/src/infrastructure/backend/index.ts";
      const { backend } = await import(path);
      const context = (await backend.runtimeInfo()).context;
      void backend.runP4({
        operationId: id,
        command: "info",
        args: [],
        context,
        source: "terminal",
        outputMode: "text",
      });
    }, operationId);
  await startCommand("footer-slot-running");
  await page.clock.runFor(120);
  await expect(status).toContainText("running");
  // The slot keeps its box while the operation runs.
  expect((await status.boundingBox())!.height).toBeCloseTo(idleStatusHeight, 0);
  expect((await center.boundingBox())!.height).toBe(centerHeight);
  expect((await queryBar.boundingBox())!.y).toBe(queryTop);
  await status.click();
  await expect(taskList).toBeVisible();
  await expect(taskList.locator(".task-row")).toHaveCount(1);
  await expect(
    taskList.getByRole("progressbar", { name: "p4 info progress" }),
  ).toHaveCount(1);
  // Completion returns the footer to idle without any layout shift.
  await page.clock.runFor(300);
  await expect(taskList.locator(".task-row")).toHaveCount(0);
  await expect(taskList).toContainText("P4 idle");
  await expect(status).toContainText("P4 idle");
  expect((await center.boundingBox())!.height).toBe(centerHeight);
  expect((await queryBar.boundingBox())!.y).toBe(queryTop);
  // A failed cancellation is reported in the same slot instead of a transient
  // toolbar banner.
  await page.evaluate(async () => {
    const path = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(path);
    backend.cancelOperation = async () => {
      throw new Error("Cancel transport failed");
    };
  });
  await startCommand("footer-slot-failed");
  await page.clock.runFor(120);
  await expect(taskList.locator(".task-row")).toHaveCount(1);
  await taskList
    .getByRole("button", {
      name: "Cancel task: p4 info (footer-slot-failed)",
      exact: true,
    })
    .click();
  await expect(taskList.getByRole("alert")).toContainText(
    "Cancellation failed",
  );
  expect((await center.boundingBox())!.height).toBe(centerHeight);
  expect((await queryBar.boundingBox())!.y).toBe(queryTop);
  await page.clock.resume();
});
