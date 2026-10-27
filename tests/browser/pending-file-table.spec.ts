import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`pending file table sorts and combines filters without overflowing at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.leftOpen", "false");
      localStorage.removeItem("p4deck.pending-filter.v1");
    });
    await page.goto("/#/files");
    await page.evaluate(async () => {
      const path = "/src/infrastructure/backend/index.ts";
      const { backend } = await import(path);
      const writeCount = window as unknown as { pendingWrites: number };
      writeCount.pendingWrites = 0;
      const unexpectedWrite = async () => {
        writeCount.pendingWrites++;
        throw new Error("Opening header actions must not execute a write");
      };
      backend.performFileAction = unexpectedWrite;
      backend.confirmSubmit = unexpectedWrite;
      backend.confirmShelf = unexpectedWrite;
      const runtime = await backend.runtimeInfo();
      const files = [
        { path: "Scripts/z10.CS", action: "edit", state: "openedEdit" },
        { path: "Assets/z2.mat", action: "delete", state: "openedDelete" },
        { path: "Scripts/z2.cs", action: "add", state: "openedAdd" },
        { path: ".p4ignore", action: "edit", state: "openedEdit" },
      ].map((file) => ({
        ...file,
        depotPath: `//depot/root/${file.path}`,
        clientPath: `//${runtime.context.client}/${file.path}`,
      }));
      backend.queryPendingChanges = async (query: {
        requestGeneration: number;
      }) => ({
        requestGeneration: query.requestGeneration,
        items: [
          {
            id: 20261,
            description: "Mixed file types",
            user: runtime.context.user,
            client: runtime.context.client,
            status: "pending",
            jobs: [],
            files,
            shelvedFiles: files,
          },
        ],
        hasMore: false,
        partial: false,
        stats: {
          scannedCount: 1,
          matchedCount: 1,
          truncatedBySafetyLimit: false,
        },
      });
    });
    await page
      .getByRole("navigation", { name: "Activity bar" })
      .getByRole("button", { name: /^Pending/ })
      .click();
    await page.locator('[data-pending-change="20261"]').click();
    const table = page.getByRole("grid", { name: "Opened files", exact: true });
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveCount(5);
    await expect(table.locator(".pending-file-name")).toHaveText([
      ".p4ignore",
      "z2.mat",
      "z2.cs",
      "z10.CS",
    ]);
    // Toolbar actions must use the complete multi-selection, not only the
    // primary row that was clicked last.
    const visibleRows = table.locator(".pending-file");
    await visibleRows.nth(0).click();
    await visibleRows.nth(1).click({ modifiers: ["Control"] });
    await expect(
      table.locator('.pending-file[aria-selected="true"]'),
    ).toHaveCount(2);
    await expect(page.locator(".selection-summary")).toHaveCount(0);
    const objectActions = page.getByRole("toolbar", {
      name: "Object actions",
      exact: true,
    });
    const revert = objectActions.getByRole("button", {
      name: "Revert",
      exact: true,
    });
    await expect(revert).toBeEnabled();
    await revert.click();
    const selectionRevertDialog = page.getByRole("dialog", {
      name: "Confirm: Revert",
      exact: true,
    });
    await expect(selectionRevertDialog.getByRole("listitem")).toHaveCount(2);
    await expect(selectionRevertDialog.getByRole("listitem")).toHaveText([
      "//depot/root/.p4ignore",
      "//depot/root/Assets/z2.mat",
    ]);
    await selectionRevertDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(table).toBeVisible();
    await expect(
      page.locator(".pending-body h4").filter({ hasText: /opened files/i }),
    ).toHaveCount(0);
    expect(
      (await table.locator(".pending-file-header").boundingBox())!.height,
    ).toBeLessThanOrEqual(36);
    expect(
      (await table.getByLabel("Filter by status").boundingBox())!.width,
    ).toBeLessThanOrEqual(100);
    expect(
      (await table.getByLabel("Filter by type").boundingBox())!.width,
    ).toBeLessThanOrEqual(92);
    expect(
      (await table.locator(".pending-file").first().boundingBox())!.height,
    ).toBe(30);
    await expect(
      table.locator("..").locator(".pending-file-tools"),
    ).toHaveCount(0);
    const headers = table.getByRole("columnheader");
    const resize = table.getByRole("separator", {
      name: "Resize File path column",
      exact: true,
    });
    const before = await headers.nth(2).boundingBox();
    await resize.scrollIntoViewIfNeeded();
    const handle = (await resize.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 20);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 90, handle.y + 20, {
      steps: 5,
    });
    await page.mouse.up();
    expect((await headers.nth(2).boundingBox())!.width).toBeCloseTo(
      before!.width + 90,
      0,
    );
    // Narrow paths still show the full relative path in the native tooltip.
    await resize.focus();
    await resize.press("Home");
    expect((await headers.nth(2).boundingBox())!.width).toBe(140);
    await resize.press("ArrowRight");
    expect((await headers.nth(2).boundingBox())!.width).toBe(150);
    const firstPath = table.locator(".pending-file-path").nth(3);
    await expect(firstPath).toHaveAttribute("title", "Scripts/z10.CS");
    await expect(firstPath).toHaveCSS("text-overflow", "ellipsis");
    await expect(firstPath).toHaveCSS("white-space", "nowrap");
    // Every header has its own handle, including the rightmost column.
    for (const [index, name] of [
      [0, "Icon"],
      [1, "File name"],
      [3, "Status"],
      [4, "Type"],
    ] as const) {
      const columnHandle = table.getByRole("separator", {
        name: `Resize ${name} column`,
        exact: true,
      });
      const previous = (await headers.nth(index).boundingBox())!.width;
      await columnHandle.focus();
      await columnHandle.press("ArrowRight");
      expect((await headers.nth(index).boundingBox())!.width).toBeCloseTo(
        previous + 10,
        0,
      );
    }
    await expect(table.locator(".pending-file-path")).toHaveText([
      ".p4ignore",
      "Assets/z2.mat",
      "Scripts/z2.cs",
      "Scripts/z10.CS",
    ]);
    await table
      .getByRole("button", { name: "Sort by path", exact: true })
      .click();
    await expect(table.locator('[aria-sort="descending"]')).toBeVisible();
    await expect(table.locator(".pending-file-path")).toHaveText([
      "Scripts/z10.CS",
      "Scripts/z2.cs",
      "Assets/z2.mat",
      ".p4ignore",
    ]);
    await table.getByLabel("Filter by status").selectOption("edit");
    await table.getByLabel("Filter by type").selectOption(".cs");
    await expect(table.locator(".pending-file-path")).toHaveText([
      "Scripts/z10.CS",
    ]);
    // CL actions always include the full CL, even with just one visible file.
    const actions = page.getByRole("group", {
      name: "CL 20261 actions",
      exact: true,
    });
    const submit = actions.getByRole("button", {
      name: "Submit CL 20261",
      exact: true,
    });
    await submit.focus();
    await submit.press("Enter");
    const submitDialog = page.getByRole("dialog", {
      name: "Submit entire CL 20261",
      exact: true,
    });
    await expect(submitDialog).toBeVisible();
    await expect(
      submitDialog.getByRole("button", {
        name: "Confirm entire CL submission",
        exact: true,
      }),
    ).toBeDisabled();
    await submitDialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(table).toBeVisible();
    await actions
      .getByRole("button", { name: "Revert all CL 20261", exact: true })
      .click();
    const revertDialog = page.getByRole("dialog", {
      name: "Confirm: Revert",
      exact: true,
    });
    await expect(revertDialog.getByRole("listitem")).toHaveCount(4);
    await expect(revertDialog.getByRole("checkbox")).toHaveCount(0);
    await expect(
      revertDialog.getByRole("button", {
        name: "Confirm operation",
        exact: true,
      }),
    ).toBeEnabled();
    await revertDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(table).toBeVisible();
    await actions
      .getByRole("button", { name: "Shelve all CL 20261", exact: true })
      .click();
    const shelfDialog = page.getByRole("dialog", {
      name: "Shelve files",
      exact: true,
    });
    await expect(shelfDialog.getByRole("listitem")).toHaveCount(4);
    await expect(shelfDialog.getByRole("listitem")).toHaveText([
      "//depot/root/.p4ignore",
      "//depot/root/Assets/z2.mat",
      "//depot/root/Scripts/z10.CS",
      "//depot/root/Scripts/z2.cs",
    ]);
    await shelfDialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(table).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { pendingWrites: number }).pendingWrites,
      ),
    ).toBe(0);
    await expect(
      page
        .getByRole("grid", { name: "Shelved files", exact: true })
        .locator(".pending-file"),
    ).toHaveCount(4);
    const alignment = await table.evaluate((element) => {
      const head = element
        .querySelector('[aria-label="Filter by status"]')!
        .closest('[role="columnheader"]')!
        .getBoundingClientRect();
      const cell = element
        .querySelector(".pending-file-status")!
        .getBoundingClientRect();
      return Math.abs(head.x - cell.x);
    });
    expect(alignment).toBeLessThan(1);
    await table.getByLabel("Filter by status").selectOption("delete");
    await expect(table.getByRole("status")).toHaveText("No matching files");
    await table
      .locator("..")
      .getByRole("button", { name: "Clear filters" })
      .click();
    await expect(table.locator(".pending-file")).toHaveCount(4);
    await table.getByLabel("Filter by type").selectOption("(none)");
    await expect(table.locator(".pending-file-path")).toHaveText([".p4ignore"]);
    expect(
      await page.evaluate(() => document.querySelector("#root")!.scrollWidth),
    ).toBe(width);
    const axe = await new AxeBuilder({ page })
      .include(".pending-file-table-wrap")
      .analyze();
    expect(axe.violations).toEqual([]);
    await table
      .locator("..")
      .getByRole("button", { name: "Clear filters" })
      .click();
    await table.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await page.screenshot({
      path: testInfo.outputPath("pending-file-table.png"),
    });
    await page.evaluate(async () => {
      const path = "/src/infrastructure/backend/index.ts";
      const { backend } = await import(path);
      backend.performFileAction = async (request: unknown) => {
        Object.assign(window, { unchangedRequest: request });
        return {
          operation: {
            operationId: "unchanged",
            exitCode: 0,
            durationMs: 1,
            events: [],
          },
          affectedPaths: [],
          message: "Unchanged files reverted",
        };
      };
    });
    await table.getByLabel("Filter by status").selectOption("edit");
    await table.getByLabel("Filter by type").selectOption(".cs");
    await actions
      .getByRole("button", { name: "Revert unchanged CL 20261", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as any).unchangedRequest))
      .toMatchObject({ action: "revertUnchanged", changelistId: 20261 });
    expect(
      await page.evaluate(() =>
        (window as any).unchangedRequest.paths.slice().sort(),
      ),
    ).toEqual([
      "//depot/root/.p4ignore",
      "//depot/root/Assets/z2.mat",
      "//depot/root/Scripts/z10.CS",
      "//depot/root/Scripts/z2.cs",
    ]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await table
      .locator("..")
      .getByRole("button", { name: "Clear filters" })
      .click();
    await page.evaluate(async () => {
      const path = "/src/infrastructure/backend/index.ts";
      const { backend } = await import(path);
      backend.performFileAction = async (request: unknown) => {
        Object.assign(window, { wholeRevertRequest: request });
        return {
          operation: {
            operationId: "whole-revert",
            exitCode: 0,
            durationMs: 1,
            events: [],
          },
          affectedPaths: [],
          message: "Whole changelist reverted",
        };
      };
    });
    const wholeRows = table.locator(".pending-file");
    await expect(wholeRows).toHaveCount(4);
    await wholeRows.nth(0).click();
    for (let index = 1; index < 4; index++)
      await wholeRows.nth(index).click({ modifiers: ["Control"] });
    await expect(
      table.locator('.pending-file[aria-selected="true"]'),
    ).toHaveCount(4);
    await revert.click();
    const wholeRevertDialog = page.getByRole("dialog", {
      name: "Confirm: Revert",
      exact: true,
    });
    await expect(wholeRevertDialog.getByRole("listitem")).toHaveCount(4);
    await wholeRevertDialog
      .getByRole("button", { name: "Confirm operation", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as any).wholeRevertRequest))
      .toMatchObject({
        action: "revert",
        changelistId: 20261,
        revertWholeChangelist: true,
      });
    expect(
      await page.evaluate(() =>
        (window as any).wholeRevertRequest.paths.slice().sort(),
      ),
    ).toEqual([
      "//depot/root/.p4ignore",
      "//depot/root/Assets/z2.mat",
      "//depot/root/Scripts/z10.CS",
      "//depot/root/Scripts/z2.cs",
    ]);
  });
}
