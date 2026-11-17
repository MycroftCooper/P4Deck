import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`diff has aligned, virtualized sides and synchronized scrolling at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
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
    const path = page.getByRole("textbox", { name: "Diff file path" });
    await path.fill("//atlas/main/Scripts/Example.cs");
    await path.press("Enter");
    await expect(path).toHaveValue("Scripts/Example.cs");
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
      review.getByRole("button", { name: "Configure Swarm", exact: true }),
    ).toHaveCount(0);
    // The renderer owns one side-by-side grid: two equal columns in the same
    // scroll surface, so a changed row lines up across the split.
    await expect(
      review.getByRole("button", { name: "Side-by-side view" }),
    ).toHaveAttribute("aria-pressed", "true");
    type Box = { x: number; y: number; width: number; height: number } | null;
    type Layout = {
      split: string | null;
      deletions: Box;
      additions: Box;
      leftChange: Box;
      rightChange: Box;
      rows: number;
      scrollRoots: number;
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
      firstDeletionLine: string | null;
      firstAdditionLine: string | null;
      probed: Record<string, boolean>;
    };
    const readLayout = (probe: number[] = []): Promise<Layout> =>
      page.evaluate((lines) => {
        const host = document.querySelector<HTMLElement>(".diff-renderer");
        const shadow = host?.shadowRoot;
        const box = (element: Element | null | undefined) =>
          element
            ? (() => {
                const { x, y, width, height } = element.getBoundingClientRect();
                return { x, y, width, height };
              })()
            : null;
        const scroll = document.querySelector<HTMLElement>(".diff-scroll-root");
        const rows = shadow
          ? [...shadow.querySelectorAll<HTMLElement>("[data-line]")]
          : [];
        const column = (side: "deletions" | "additions") =>
          shadow
            ? [
                ...shadow.querySelectorAll<HTMLElement>(
                  `code[data-${side}] [data-line]`,
                ),
              ]
            : [];
        const change = (type: string) =>
          rows.find((row) => row.getAttribute("data-line-type") === type);
        const deletions = column("deletions");
        const additions = column("additions");
        return {
          split:
            shadow?.querySelector("pre")?.getAttribute("data-diff-type") ??
            null,
          deletions: box(shadow?.querySelector("code[data-deletions]")),
          additions: box(shadow?.querySelector("code[data-additions]")),
          leftChange: box(change("change-deletion")),
          rightChange: box(change("change-addition")),
          rows: rows.length,
          scrollRoots: document.querySelectorAll(".diff-scroll-root").length,
          scrollTop: scroll?.scrollTop ?? 0,
          scrollHeight: scroll?.scrollHeight ?? 0,
          clientHeight: scroll?.clientHeight ?? 0,
          firstDeletionLine: deletions[0]?.getAttribute("data-line") ?? null,
          firstAdditionLine: additions[0]?.getAttribute("data-line") ?? null,
          probed: Object.fromEntries(
            lines.map((line) => [
              String(line),
              !!shadow?.querySelector(`[data-line="${line}"]`),
            ]),
          ),
        };
      }, probe);
    await expect.poll(async () => (await readLayout()).rows).toBeGreaterThan(0);
    const loaded = await readLayout();
    expect(loaded.split).toBe("split");
    expect(loaded.scrollRoots).toBe(1);
    // Columns share the top edge and width; the removed and added halves of the
    // first change sit on the same row.
    const { deletions, additions, leftChange, rightChange } = loaded;
    expect(deletions && additions && leftChange && rightChange).toBeTruthy();
    expect(Math.abs(deletions!.y - additions!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(deletions!.width - additions!.width)).toBeLessThanOrEqual(
      1,
    );
    expect(additions!.x).toBeGreaterThanOrEqual(
      deletions!.x + deletions!.width - 1,
    );
    expect(deletions!.height).toBeGreaterThan(80);
    expect(Math.abs(leftChange!.y - rightChange!.y)).toBeLessThanOrEqual(1);
    // Collapsed context renders only the hunks, so the first read is small.
    expect(loaded.rows).toBeLessThan(60);
    await expect(
      review.locator('[data-line][data-line-type="change-deletion"]').first(),
    ).toContainText("const cache = false;");
    await expect(
      review.locator('[data-line][data-line-type="change-addition"]').first(),
    ).toContainText("const cache = true;");
    // Context starts folded, so expanding is what exposes the whole 1500-line
    // file; the renderer then keeps only a window of rows in the DOM.
    await review.getByRole("button", { name: "Expand all" }).click();
    await expect(
      review.getByRole("button", { name: "Expand all" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => (await readLayout()).scrollHeight)
      .toBeGreaterThan(20_000);
    const expanded = await readLayout();
    // 1500 lines on each side: a non-virtualized render would mount >3000 rows.
    expect(expanded.rows).toBeLessThan(600);
    expect(expanded.rows).toBeGreaterThan(20);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".diff-scroll-root")!.scrollTop =
        12_000;
    });
    await expect.poll(async () => (await readLayout()).scrollTop).toBe(12_000);
    // One surface scrolls both columns together: the early rows are gone and
    // both sides now show the same deep window.
    await expect
      .poll(async () => (await readLayout([1])).probed["1"])
      .toBe(false);
    const scrolled = await readLayout([1, 1201]);
    expect(scrolled.rows).toBeLessThan(600);
    expect(scrolled.probed["1"]).toBe(false);
    expect(Number(scrolled.firstDeletionLine)).toBeGreaterThan(400);
    expect(Number(scrolled.firstAdditionLine)).toBeGreaterThan(400);
    expect(
      Math.abs(
        Number(scrolled.firstDeletionLine) - Number(scrolled.firstAdditionLine),
      ),
    ).toBeLessThanOrEqual(4);
    expect(
      Math.abs((scrolled.deletions?.y ?? 0) - (scrolled.additions?.y ?? 0)),
    ).toBeLessThanOrEqual(1);
    const calls = await page.evaluate(
      () => (window as any).splitDiffReads.calls,
    );
    const scrollRoot = review.locator(".diff-scroll-root");
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".diff-scroll-root")!.scrollTop = 0;
    });
    await expect.poll(async () => (await readLayout()).scrollTop).toBe(0);
    // Hunk navigation uses the already-loaded texts. The buttons advertise the
    // Alt+Arrow shortcuts, which is also how a narrow window reaches them.
    const nextHunk = review.getByRole("button", {
      name: "Next hunk",
      exact: true,
    });
    const previousHunk = review.getByRole("button", {
      name: "Previous hunk",
      exact: true,
    });
    await expect(nextHunk).toBeEnabled();
    await expect(previousHunk).toBeEnabled();
    await scrollRoot.focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(review.locator(".diff-hunk-count")).toHaveText("1/2 hunks");
    await page.keyboard.press("Alt+ArrowDown");
    await expect(review.locator(".diff-hunk-count")).toHaveText("2/2 hunks");
    await expect(
      page.locator('[data-line][data-line-type="change-addition"]', {
        hasText: "const finalEdit = true;",
      }),
    ).toBeVisible();
    await scrollRoot.focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(review.locator(".diff-hunk-count")).toHaveText("1/2 hunks");
    // Each side's menu selects only that side, including unmounted rows.
    await page
      .locator('[data-line][data-line-type="change-addition"]')
      .first()
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Select all diff text on the right" })
      .click();
    const fullText = page.getByRole("dialog", { name: "Select full text" });
    await expect(fullText).toBeVisible();
    const fullTextBox = fullText.getByRole("textbox", {
      name: "Full text",
      exact: true,
    });
    await expect(fullTextBox).toHaveValue(/const cache = true/);
    await expect(fullTextBox).toHaveValue(/line 1503/);
    await expect(fullTextBox).not.toHaveValue(/const cache = false/);
    await page.keyboard.press("Escape");
    await expect(fullText).toBeHidden();
    await scrollRoot.focus();
    await page.keyboard.press("Control+f");
    const search = review.getByRole("textbox", { name: "Find text" });
    await expect(search).toBeFocused();
    await search.fill("line 1200");
    // The line exists on both sides, so both sides are matched and navigable.
    await expect(review.locator(".diff-match-count")).toHaveText("1/2");
    await expect(review.locator("mark[data-p4d-active]").first()).toHaveText(
      "line 1200",
    );
    await search.fill("const");
    await expect(review.locator(".diff-match-count")).toHaveText("1/4");
    await expect(
      review.locator("code[data-deletions] mark[data-p4d-active]"),
    ).toHaveText("const");
    await search.press("Enter");
    await expect(review.locator(".diff-match-count")).toHaveText("2/4");
    await expect(
      review.locator("code[data-additions] mark[data-p4d-active]"),
    ).toHaveText("const");
    await search.press("Shift+Enter");
    await expect(review.locator(".diff-match-count")).toHaveText("1/4");
    // Pane focus and the line-jump side never narrow or restart search.
    await scrollRoot.focus();
    await expect(review.locator(".diff-match-count")).toHaveText("1/4");
    await expect(
      review.locator("code[data-deletions] mark[data-p4d-active]"),
    ).toHaveText("const");
    await search.press("Escape");
    await expect(review.locator(".diff-match-count")).toHaveText("");
    await search.press("Control+g");
    const line = review.getByRole("textbox", {
      name: "Go to line",
      exact: true,
    });
    await expect(line).toBeFocused();
    await line.fill("1400");
    await line.press("Enter");
    const target = page.locator('[data-line="1400"]');
    await expect(target).toHaveCount(2);
    await expect(target.first()).toBeInViewport();
    await review
      .getByRole("combobox", { name: "Jump side" })
      .selectOption("left");
    await line.fill("1400");
    await line.press("Enter");
    await expect(target.first()).toBeInViewport();
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
    // The rendered diff and the search state survive the re-read.
    await expect(review.locator(".diff-body")).toBeVisible();
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
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".diff-scroll-root")!.scrollTop = 0;
    });
    await expect.poll(async () => (await readLayout()).scrollTop).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("split-diff.png") });
  });
}
