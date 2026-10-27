import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function prepare(page: Page, numbered = true) {
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "false");
    localStorage.setItem(
      "p4deck.ui",
      JSON.stringify({ autoRefresh: false, checkoutUseDefault: false }),
    );
  });
  await page.goto("/#/files");
  await expect(page.locator(".file-workbench h1")).toBeVisible();
  await page.evaluate(async (hasNumbered) => {
    const path = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(path);
    const runtime = await backend.runtimeInfo();
    const nodes = ["checkout-fixture.txt", "second-fixture.txt"].map(
      (name) => ({
        id: name,
        name,
        relativePath: name,
        absolutePath: `${runtime.context.cwd}/${name}`,
        depotPath: `//depot/${name}`,
        state: "controlled",
        kind: "file",
      }),
    );
    const state = { reads: 0, writes: [] as any[], failRead: false };
    Object.assign(window, { checkoutFixture: state });
    backend.listWorkspaceChildren = async () => ({
      items: nodes,
      completeness: "complete",
      errors: [],
      operationIds: [],
      truncated: false,
      safetyLimit: 10000,
      cacheFreshness: "fresh",
    });
    backend.queryPendingChanges = async (query: any) => {
      state.reads++;
      if (state.failRead) throw new Error("Checkout CL query unavailable");
      const change = (id: number) => ({
        id,
        description: `Checkout work ${id}\nFull description`,
        user: runtime.context.user,
        client: runtime.context.client,
        status: "pending",
        jobs: [],
        files: [],
        shelvedFiles: [],
      });
      return {
        requestGeneration: query.requestGeneration,
        defaultChange: change(0),
        items: hasNumbered ? [change(123), change(456)] : [],
        hasMore: false,
        partial: false,
        stats: {
          scannedCount: 3,
          matchedCount: 3,
          truncatedBySafetyLimit: false,
        },
      };
    };
    backend.performFileAction = async (request: any) => {
      state.writes.push(request);
      return {
        operation: {
          operationId: request.operationId,
          exitCode: 0,
          events: [],
          durationMs: 1,
        },
        affectedPaths: request.paths,
        message: "Checked out",
      };
    };
  }, numbered);
  await page
    .getByRole("toolbar", { name: "Object actions" })
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await page
    .getByRole("option")
    .filter({ hasText: "checkout-fixture.txt" })
    .click();
  await expect(
    page.getByRole("button", { name: "Checkout", exact: true }),
  ).toBeEnabled();
}

for (const width of [1280, 390])
  test(`checkout chooses a numbered CL or cancels without writing at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await prepare(page);
    const checkout = page.getByRole("button", {
      name: "Checkout",
      exact: true,
    });
    await checkout.click();
    let dialog = page.getByRole("dialog", {
      name: "Select checkout changelist",
    });
    await dialog
      .getByRole("combobox", { name: "Target changelist", exact: true })
      .selectOption("123");
    await expect(
      dialog.getByRole("textbox", {
        name: "Changelist description",
        exact: true,
      }),
    ).toHaveValue("Checkout work 123\nFull description");
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
      await page.evaluate(() => (window as any).checkoutFixture.writes),
    ).toHaveLength(0);
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("p4deck.ui")!).checkoutUseDefault,
      ),
    ).toBe(false);
    await checkout.click();
    dialog = page.getByRole("dialog", { name: "Select checkout changelist" });
    await dialog
      .getByRole("combobox", { name: "Target changelist", exact: true })
      .selectOption("456");
    expect(
      (await new AxeBuilder({ page }).include("dialog").analyze()).violations,
    ).toEqual([]);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await dialog
      .getByRole("button", { name: "Check out", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).checkoutFixture.writes.length),
      )
      .toBe(1);
    expect(
      await page.evaluate(() => (window as any).checkoutFixture.writes[0]),
    ).toMatchObject({
      action: "checkout",
      changelistId: 456,
      paths: ["//depot/checkout-fixture.txt"],
    });
  });

test("always Default is persisted, skips the picker and can be turned off in Settings", async ({
  page,
}) => {
  await prepare(page);
  const checkout = page.getByRole("button", { name: "Checkout", exact: true });
  await checkout.click();
  let dialog = page.getByRole("dialog", { name: "Select checkout changelist" });
  await dialog
    .getByRole("combobox", { name: "Target changelist", exact: true })
    .selectOption("123");
  await dialog.getByRole("checkbox").check();
  await expect(
    dialog.getByRole("combobox", { name: "Target changelist", exact: true }),
  ).toHaveValue("0");
  await expect(
    dialog.getByRole("combobox", { name: "Target changelist", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Check out", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).checkoutFixture.writes.length),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => (window as any).checkoutFixture.writes[0].changelistId,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("p4deck.ui")!).checkoutUseDefault,
    ),
  ).toBe(true);
  const reads = await page.evaluate(
    () => (window as any).checkoutFixture.reads,
  );
  await expect(checkout).toBeEnabled();
  await checkout.click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).checkoutFixture.writes.length),
    )
    .toBe(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).checkoutFixture.reads)).toBe(
    reads,
  );
  await page
    .getByRole("navigation", { name: "Activity bar" })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page
    .getByRole("combobox", {
      name: "Always check out to Default CL",
      exact: true,
    })
    .selectOption("false");
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("p4deck.ui")!).checkoutUseDefault,
    ),
  ).toBe(false);
  await page
    .getByRole("navigation", { name: "Activity bar" })
    .getByRole("button", { name: /^Files/ })
    .click();
  await page
    .getByRole("option")
    .filter({ hasText: "checkout-fixture.txt" })
    .click();
  await checkout.click();
  await expect(
    page.getByRole("dialog", { name: "Select checkout changelist" }),
  ).toBeVisible();
});

test("only Default checks out directly and a query failure never falls back to Default", async ({
  page,
}) => {
  await prepare(page, false);
  const checkout = page.getByRole("button", { name: "Checkout", exact: true });
  await checkout.click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).checkoutFixture.writes.length),
    )
    .toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as any).checkoutFixture.writes[0].changelistId,
    ),
  ).toBe(0);
  await page.evaluate(() => {
    (window as any).checkoutFixture.failRead = true;
  });
  await expect(checkout).toBeEnabled();
  await checkout.click();
  await expect(
    page.getByRole("button", { name: "Operation failed, view operations" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).checkoutFixture.writes.length),
  ).toBe(1);
});
