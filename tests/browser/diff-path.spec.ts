import { expect, test } from "@playwright/test";

test("diff paths stay workspace-relative and normalize pasted paths without querying while typing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "false");
    localStorage.setItem("p4deck.ui", JSON.stringify({ autoRefresh: false }));
  });
  await page.goto("/#/files");
  await expect(page.locator(".brand")).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = "/src/infrastructure/backend/index.ts";
    const { backend } = await import(modulePath);
    const state = { diffs: [] as string[], mappings: [] as string[] };
    Object.assign(window, { diffPathReads: state });
    const getDiff = backend.getDiff;
    backend.getDiff = async (request: any) => {
      state.diffs.push(request.scope.fileIdentity);
      return getDiff(request);
    };
    backend.resolvePath = async ({ input }: { input: string }) => {
      state.mappings.push(input);
      if (input.startsWith("//outside/"))
        return { found: false, inputKind: "depot", reason: "Not mapped" };
      if (input === "//atlas/main/Late.cs")
        await new Promise<void>((resolve) =>
          Object.assign(window, { releaseLateMapping: resolve }),
        );
      const relativePath = input
        .replace(/^\/\/atlas\/main\//, "")
        .replace(/^\/workspace\/atlas\//, "");
      return {
        found: true,
        inputKind: input.startsWith("//") ? "depot" : "absolute",
        absolutePath: `/workspace/atlas/${relativePath}`,
        relativePath,
      };
    };
    location.hash = "#/diff";
  });
  const path = page.getByRole("textbox", { name: "Diff 文件路径" });
  const readCounts = () =>
    page.evaluate(() => {
      const state = (window as any).diffPathReads;
      return { diffs: state.diffs.length, mappings: state.mappings.length };
    });
  const paste = (text: string) =>
    path.evaluate((input, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    }, text);
  const depot = "//atlas/main/Assets/Code/Example.cs";
  await path.fill(depot);
  await path.press("Enter");
  await expect(path).toHaveValue("Assets/Code/Example.cs");
  await expect(path).toHaveAttribute("title", depot);
  await expect(page.locator(".diff-side-line").first()).toBeVisible();
  const beforeTyping = await readCounts();
  await path.press("Enter"); // Reaccepting the relative display keeps depot identity.
  await path.fill("Assets/Code/Other.cs");
  await path.press("Backspace");
  expect(await readCounts()).toEqual(beforeTyping);
  await path.press("Escape");
  await expect(path).toHaveValue("Assets/Code/Example.cs");

  for (const [raw, relative] of [
    [' "/workspace/atlas/Assets/A File.cs"\r\n', "Assets/A File.cs"],
    [String.raw`.\Assets\Code\..\世界.cs`, "Assets/世界.cs"],
    ["file:///workspace/atlas/Assets/A%20File.cs", "Assets/A File.cs"],
    ["//atlas-main-fm/Assets/FromClient.cs", "Assets/FromClient.cs"],
    ["Assets/Relative.cs", "Assets/Relative.cs"],
  ]) {
    await paste(raw);
    await expect(path).toHaveValue(relative);
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).diffPathReads.diffs.at(-1)),
      )
      .toBe(`/workspace/atlas/${relative}`);
    await expect(page.locator(".diff-view")).toHaveAttribute(
      "aria-busy",
      "false",
    );
  }
  // Late results for a previous target cannot replace the current display.
  await paste("//atlas/main/Late.cs");
  await expect
    .poll(() => page.evaluate(() => !!(window as any).releaseLateMapping))
    .toBe(true);
  await paste("//atlas/main/Assets/Latest.cs");
  await expect(path).toHaveValue("Assets/Latest.cs");
  await page.evaluate(() => (window as any).releaseLateMapping());
  await expect(path).toHaveValue("Assets/Latest.cs");

  await paste("//outside/another-workspace/File.cs");
  await expect(path).toHaveValue("//outside/another-workspace/File.cs");
  await expect(page.locator(".diff-view")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const beforeInvalidPaste = await readCounts();
  await paste("https://example.com");
  await expect(path).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".diff-path-error")).toContainText(
    "File paths only",
  );
  expect(await readCounts()).toEqual(beforeInvalidPaste);
  await path.press("Escape");
  await expect(page.locator(".diff-path-error")).toHaveCount(0);
  const followSelection = page.locator(".target-controls > button").first();
  await expect(followSelection).toHaveAccessibleName("Follow selection");
  await followSelection.click();
  await expect(followSelection).toHaveAccessibleName("Target locked");
  await expect(path).toBeDisabled();
  const pageTitle = page.locator(".target-page-title");
  await expect(pageTitle).toHaveText("Diff");
  await expect(pageTitle.locator("svg")).toBeVisible();
  await expect(pageTitle).toHaveCSS("font-size", "14px");
  const [titleBounds, followBounds] = await Promise.all([
    pageTitle.boundingBox(),
    followSelection.boundingBox(),
  ]);
  expect(followBounds!.x - (titleBounds!.x + titleBounds!.width)).toBeLessThan(
    12,
  );
});
