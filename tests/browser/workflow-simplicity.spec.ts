import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
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
    backend.preflightMoveFiles = async (request: any) => {
      Object.assign(window, { moveCheck: request });
      return {
        ready: true,
        token: "move-token",
        expiresAt: Date.now() + 60000,
        ttlMs: 60000,
        target: {
          kind: "move",
          server: runtime.context.server,
          user: runtime.context.user,
          client: runtime.context.client,
          workspace: runtime.context.cwd,
          contextGeneration: 0,
          targetChangeId: request.targetChangeId,
          depotPaths: request.depotPaths,
        },
        files: [],
        blockers: [],
        warnings: [],
        contentDigest: "test",
        operationIds: [],
      };
    };
    backend.confirmMoveFiles = async (request: any) => {
      Object.assign(window, { moveExecution: request });
      changes[1].files.push(changes[0].files.shift()!);
      return {
        outcome: "succeeded",
        message: "Moved file",
        operationIds: [request.operationId],
        files: [
          {
            depotPath: "//depot/simplicity.txt",
            state: "succeeded",
            message: "Moved",
          },
        ],
        affectedChanges: [310, 320],
        refreshedChanges: structuredClone(changes),
        refresh: {
          pendingChanges: true,
          workspaceStatus: true,
          depotPaths: ["//depot/simplicity.txt"],
          reason: "move",
        },
      };
    };
  });
  await page
    .getByRole("navigation", { name: "Activity bar" })
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
  expect(await page.evaluate(() => (window as any).moveCheck)).toMatchObject({
    targetChangeId: 320,
    depotPaths: ["//depot/simplicity.txt"],
  });
  expect(await page.evaluate(() => (window as any).dialogsOpened)).toBe(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(source.locator(".pending-file")).toHaveCount(0);
  await destination.locator("header").click();
  await expect(destination.locator(".pending-file")).toHaveCount(1);
  expect((await page.locator(".pending-query-bar").boundingBox())!.y).toBe(top);
  await expect(page.locator(".pending-page > .workspace-notice")).toHaveCount(
    0,
  );
});

test("operation spinner, completion and error stay in a fixed toolbar slot", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(async () => {
    const path = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(path);
    const readPending = backend.queryPendingChanges.bind(backend);
    let holdRefresh = true;
    backend.queryPendingChanges = async (query: any) => {
      if (holdRefresh)
        await new Promise<void>((resolve) => {
          Object.assign(window, { releaseMutationRefresh: resolve });
        });
      holdRefresh = false;
      return readPending(query);
    };
    backend.performFileAction = (request: any) =>
      new Promise((resolve, reject) => {
        Object.assign(window, {
          finishAction: (fail: boolean) =>
            fail
              ? reject(new Error("Fixture failure"))
              : resolve({
                  operationId: request.operationId,
                  exitCode: 0,
                  durationMs: 1,
                  events: [],
                }),
        });
      });
  });
  const action = page.getByRole("button", {
    name: "Revert unchanged CL 310",
    exact: true,
  });
  const center = page.locator(".command-center");
  const height = (await center.boundingBox())!.height;
  const top = (await page.locator(".pending-query-bar").boundingBox())!.y;
  await action.click();
  await expect(
    page.getByRole("button", {
      name: "Operation in progress, view operations",
    }),
  ).toBeVisible();
  expect((await center.boundingBox())!.height).toBe(height);
  await page.evaluate(() => (window as any).finishAction(false));
  await expect(
    page.getByRole("button", { name: "Operation completed, view operations" }),
  ).toBeVisible();
  expect((await center.boundingBox())!.height).toBe(height);
  // P4 has confirmed the mutation, but its Pending cache refresh is still
  // deliberately blocked above. Completion feedback must not wait for it.
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).releaseMutationRefresh),
    )
    .toBe("function");
  await page.evaluate(() => (window as any).releaseMutationRefresh());
  await action.click();
  await page.evaluate(() => (window as any).finishAction(true));
  await expect(
    page.getByRole("button", { name: "Operation failed, view operations" }),
  ).toBeVisible();
  expect((await center.boundingBox())!.height).toBe(height);
  expect((await page.locator(".pending-query-bar").boundingBox())!.y).toBe(top);
  await expect(page.locator(".command-feedback")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Operation failed, view operations" })
    .click();
  await expect(page.locator(".tool-drawer.expanded")).toBeVisible();
});
