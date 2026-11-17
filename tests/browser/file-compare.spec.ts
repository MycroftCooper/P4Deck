import { expect, test } from "@playwright/test";

// Comparing two files is assembled entirely in the renderer: the left file is the
// review scope, the right file travels as `rightFileIdentity` alongside the two
// revisions. This pins the request the host actually receives.
test("two selected files open one diff carrying both depot identities", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("p4deck.locale", "en-US");
    localStorage.setItem("p4deck.leftOpen", "false");
  });
  await page.goto("/#/files");
  await expect(page.locator(".file-workbench .file-table")).toBeVisible();

  await page.evaluate(async () => {
    // The browser backend forwards each call to mockBackend by name at call time,
    // so wrapping the mock records exactly what the review page asks for. The
    // specifier stays in a variable so TypeScript does not try to resolve a
    // dev-server URL.
    const mockUrl = "/src/infrastructure/backend/mockBackend.ts";
    const { mockBackend } = (await import(mockUrl)) as {
      mockBackend: Record<string, (...args: unknown[]) => unknown>;
    };
    const original = mockBackend.getDiff.bind(mockBackend);
    Object.assign(window, { compareRequests: [] });
    mockBackend.getDiff = (request: unknown) => {
      (
        window as unknown as { compareRequests: unknown[] }
      ).compareRequests.push(request);
      return original(request as never);
    };
  });

  const rows = page.locator(".file-row");
  await rows.nth(3).click();
  const first = await rows.nth(3).innerText();
  await rows.nth(4).click({ modifiers: ["Control"] });
  const second = await rows.nth(4).innerText();
  await rows.nth(4).click({ button: "right" });

  await page
    .getByRole("menuitem", { name: /Compare these two files/i })
    .click();
  await expect(
    page.locator(".dv-tab", { hasText: /^Diff/ }).last(),
  ).toBeVisible();
  // The review page issues its read from an effect, so wait for the rendered
  // panes before inspecting the recorded request.
  await expect(page.locator(".diff-pane-header").first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { compareRequests: unknown[] }).compareRequests
            .length,
      ),
    )
    .toBeGreaterThan(0);

  const requests = await page.evaluate(
    () => (window as unknown as { compareRequests: any[] }).compareRequests,
  );
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    // Every read for this tab must carry the same explicit pair.
    expect(request.rightFileIdentity).toMatch(/^\/\/atlas\/main\//);
    expect(request.scope.fileIdentity).toMatch(/^\/\/atlas\/main\//);
    expect(request.rightFileIdentity).not.toBe(request.scope.fileIdentity);
    expect(request.left.kind).toBe("revision");
    expect(request.right.kind).toBe("revision");
    expect(request.left.revision).toBeGreaterThan(0);
    expect(request.right.revision).toBeGreaterThan(0);
  }
  // The two sides are the two selected rows, not two revisions of one file.
  expect(first).not.toBe(second);
});
