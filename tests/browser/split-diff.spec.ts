import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`diff has aligned, virtualized sides and synchronized scrolling at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript((width) => {
      localStorage.setItem("p4deck.locale", "en-US");
      localStorage.setItem("p4deck.leftOpen", "false");
      localStorage.setItem("p4deck.theme", width === 1280 ? "dark" : "light");
      localStorage.setItem("p4deck.autoRefresh", "false");
    }, width);
    await page.goto("/#/files");
    await page.evaluate(async () => {
      const path = "/src/infrastructure/backend/index.ts";
      const { backend } = await import(path);
      const state = { calls: 0, refreshDelay: 0 };
      Object.assign(window, { splitDiffReads: state });
      backend.getDiff = async (request: any) => {
        state.calls++;
        if (state.refreshDelay)
          await new Promise((resolve) =>
            setTimeout(resolve, state.refreshDelay),
          );
        const body = Array.from(
          { length: 1500 },
          (_, index) => `  line ${index + 4};`,
        );
        const rightBody = [...body];
        rightBody[1496] = "  const finalEdit = true;";
        const longLine = `  // ${"long code ".repeat(50)}`;
        const leftLines = [
          "function update() {",
          "  const cache = false;",
          longLine,
          ...body,
          "}",
        ];
        const rightLines = [
          "function update() {",
          "  const cache = true;",
          "  const extra = true;",
          longLine,
          ...rightBody,
          "}",
        ];
        return {
          path: request.scope.fileIdentity,
          left: {
            reference: request.left,
            label: "Have #2",
            depotPath: request.scope.fileIdentity,
            exists: true,
            binary: false,
          },
          right: {
            reference: request.right,
            label: "Workspace",
            depotPath: request.scope.fileIdentity,
            exists: true,
            binary: false,
          },
          leftText: leftLines.join("\n") + "\n",
          rightText: rightLines.join("\n") + "\n",
          unified: [
            "--- Have #2",
            "+++ Workspace",
            "@@ -1,6 +1,7 @@",
            " function update() {",
            "-  const cache = false;",
            "+  const cache = true;",
            "+  const extra = true;",
            ` ${longLine}`,
            ...body.slice(0, 3).map((line) => ` ${line}`),
            "@@ -1498,7 +1499,7 @@",
            ...body.slice(1494, 1496).map((line) => ` ${line}`),
            `-${body[1496]}`,
            `+${rightBody[1496]}`,
            ...body.slice(1497).map((line) => ` ${line}`),
            " }",
            "",
          ].join("\n"),
          stats: { additions: 3, deletions: 2, hunks: 2 },
          identical: false,
          binary: false,
          unsupported: false,
          truncated: false,
          partial: false,
          operationIds: [],
        };
      };
      location.hash = "#/diff";
    });
    const review = page.locator(".file-review-page");
    const path = page.getByRole("textbox", { name: "Diff 文件路径" });
    await path.fill("//atlas/main/Scripts/Example.cs");
    await path.press("Enter");
    await expect(path).toHaveValue("Scripts/Example.cs");
    const leftPane = review.locator('.diff-pane[data-side="left"]');
    const rightPane = review.locator('.diff-pane[data-side="right"]');
    const left = leftPane.getByRole("region");
    const right = rightPane.getByRole("region");
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();
    await expect(
      review
        .getByRole("combobox", { name: "Left reference" })
        .locator("option:checked"),
    ).toHaveText("Have #2");
    await expect(
      review
        .getByRole("combobox", { name: "Right reference" })
        .locator("option:checked"),
    ).toHaveText("Workspace");
    await expect(
      review.locator("h1, .history-path, .review-footer"),
    ).toHaveCount(0);
    await expect(
      review.getByRole("button", { name: "Configure Swarm" }),
    ).toHaveCount(0);
    await expect(left.locator(".removed code")).toHaveText(
      "  const cache = false;",
    );
    await expect(right.locator(".added code")).toHaveText([
      "  const cache = true;",
      "  const extra = true;",
    ]);
    await expect(left.locator('.empty[data-row="3"]')).toHaveText("");
    await expect(right.locator('[data-row="3"] .diff-line-number')).toHaveText(
      "3",
    );
    const leftBounds = (await left.boundingBox())!;
    const rightBounds = (await right.boundingBox())!;
    expect(rightBounds.x).toBeGreaterThanOrEqual(
      leftBounds.x + leftBounds.width,
    );
    expect(Math.abs(leftBounds.width - rightBounds.width)).toBeLessThanOrEqual(
      1,
    );
    expect(Math.abs(leftBounds.y - rightBounds.y)).toBeLessThanOrEqual(1);
    expect(leftBounds.height).toBeGreaterThan(80);
    expect(await review.locator(".diff-side-line").count()).toBeLessThan(160);
    const calls = await page.evaluate(
      () => (window as any).splitDiffReads.calls,
    );

    // Each side's menu selects only that side, including unmounted rows.
    await right.click({ button: "right", position: { x: 60, y: 50 } });
    await page
      .getByRole("menuitem", { name: "Select all diff text on this side" })
      .click();
    const fullText = page.getByRole("textbox", {
      name: "完整文本 / Full text",
    });
    await expect(fullText).toContainText("const cache = true");
    await expect(fullText).toContainText("line 1503");
    await expect(fullText).not.toContainText("const cache = false");
    await fullText.press("Escape");

    await left.evaluate((element) => {
      element.scrollTop = 12000;
    });
    await expect
      .poll(() => right.evaluate((element) => element.scrollTop))
      .toBe(12000);
    await expect(left.locator('[data-line="500"]')).toBeAttached();
    await right.evaluate((element) => {
      element.scrollTop = 18000;
    });
    await expect
      .poll(() => left.evaluate((element) => element.scrollTop))
      .toBe(18000);
    await expect(right.locator('[data-line="750"]')).toBeAttached();
    expect(await review.locator(".diff-side-line").count()).toBeLessThan(160);
    expect(
      await page.evaluate(() => (window as any).splitDiffReads.calls),
    ).toBe(calls);
    // Hunk, search and line navigation all use the already-loaded full texts.
    await review
      .getByRole("button", { name: "Next hunk", exact: true })
      .click();
    await expect(review.locator(".diff-hunk-count")).toHaveText("2/2 hunks");
    await expect(right.locator(".added code")).toHaveText(
      "  const finalEdit = true;",
    );
    await review
      .getByRole("button", { name: "Previous hunk", exact: true })
      .click();
    await expect(review.locator(".diff-hunk-count")).toHaveText("1/2 hunks");
    await expect(left.locator('[data-line="2"]')).toBeVisible();
    await right.focus();
    await right.press("Control+f");
    const search = review.getByRole("textbox", { name: "Find text" });
    await expect(search).toBeFocused();
    await search.fill("line 1200");
    await expect(review.locator(".diff-match-count")).toHaveText("1/1");
    await expect(right.locator('mark[data-active="true"]')).toHaveText(
      "line 1200",
    );
    await expect(left.locator('mark[data-active="true"]')).toHaveText(
      "line 1200",
    );
    await expect(right.locator('[data-line="1201"]')).toBeVisible();
    await search.fill("const");
    await expect(review.locator(".diff-match-count")).toHaveText("1/4");
    await expect(left.locator('mark[data-active="true"]')).toHaveText("const");
    await search.press("Enter");
    await expect(review.locator(".diff-match-count")).toHaveText("2/4");
    await expect(right.locator('mark[data-active="true"]')).toHaveText("const");
    await search.press("Shift+Enter");
    await expect(review.locator(".diff-match-count")).toHaveText("1/4");
    // Pane focus and the line-jump side never narrow or restart search.
    await right.focus();
    await expect(review.locator(".diff-match-count")).toHaveText("1/4");
    await expect(left.locator('mark[data-active="true"]')).toHaveText("const");
    await search.press("Escape");
    await search.press("Control+g");
    const line = review.getByRole("textbox", {
      name: "Go to line",
      exact: true,
    });
    await expect(line).toBeFocused();
    await line.fill("1400");
    await line.press("Enter");
    await expect(
      right.locator('.diff-target-row[data-line="1400"]'),
    ).toBeVisible();
    await review
      .getByRole("combobox", { name: "Jump side" })
      .selectOption("left");
    await line.fill("1400");
    await line.press("Enter");
    await expect(
      left.locator('.diff-target-row[data-line="1400"]'),
    ).toBeVisible();
    await line.fill("99999");
    await line.press("Enter");
    await expect(line).toHaveAttribute("aria-invalid", "true");
    await expect(review).toContainText("Line is not in the current content");
    expect(
      await page.evaluate(() => (window as any).splitDiffReads.calls),
    ).toBe(calls);
    await review
      .getByRole("combobox", { name: "Jump side" })
      .selectOption("right");
    await line.fill("");
    await search.fill("const");
    await expect(review.locator(".diff-match-count")).toHaveText("1/4");
    await search.press("Enter");
    await expect(review.locator(".diff-match-count")).toHaveText("2/4");
    await page.evaluate(() => {
      (window as any).splitDiffReads.refreshDelay = 600;
    });
    const refresh = page
      .locator(".target-controls")
      .getByRole("button", { name: "Refresh", exact: true });
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await expect(review.locator(".diff-split")).toBeVisible();
    await expect(review.locator(".diff-match-count")).toHaveText("2/4");
    await expect(refresh).toBeEnabled();
    await expect(review.locator(".diff-match-count")).toHaveText("2/4");
    await expect
      .poll(() => page.evaluate(() => (window as any).splitDiffReads.calls))
      .toBe(calls + 1);
    await search.fill("");
    expect(
      await page.evaluate(
        () => document.querySelector("#root")!.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await left.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(() => right.evaluate((element) => element.scrollTop))
      .toBe(0);
    await page.screenshot({ path: testInfo.outputPath("split-diff.png") });
  });
}
