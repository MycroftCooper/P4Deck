import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  // Exercise the actual desktop configuration without sharing its live server
  // or optimizer cache. Node fetch below sends validators even with no body in
  // a browser cache, reproducing the request that broke WebView2 startup.
  server = await createServer({
    mode: "desktop",
    cacheDir: "node_modules/.vite-desktop-regression",
    optimizeDeps: { force: true },
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      watch: null,
    },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0];
});

test.afterAll(async () => {
  await server?.close();
});

test("desktop dev serves complete assets even when WebView retains old validators", async () => {
  for (const path of [
    "/",
    "/startup.js",
    "/src/main.tsx",
    "/src/app/App.tsx",
    "/src/features/files/fileDecorations.ts",
    "/src/app/styles.css",
  ]) {
    const url = new URL(path, origin);
    const first = await fetch(url);
    expect(first.status, path).toBe(200);
    expect(first.headers.get("cache-control"), path).toBe("no-store");
    const body = await first.text();
    expect(body.length, path).toBeGreaterThan(0);
    const etag = first.headers.get("etag");
    expect(etag, path).toBeTruthy();

    const reopened = await fetch(url, {
      headers: {
        "If-None-Match": etag!,
        "If-Modified-Since":
          first.headers.get("last-modified") ?? new Date().toUTCString(),
      },
    });
    expect(reopened.status, path).toBe(200);
    expect(reopened.headers.get("cache-control"), path).toBe("no-store");
    expect(await reopened.text(), path).toBe(body);
  }
});

test("desktop frontend opens again with the same browser storage and connects HMR", async ({
  page,
}) => {
  const errors: string[] = [];
  const hmrMessages: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => errors.push(request.url()));
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) =>
      hmrMessages.push(payload.toString()),
    );
  });
  await page.goto(origin);
  await expect(page.locator(".file-workbench")).toBeVisible();
  await expect(page.locator(".startup-recovery")).toBeHidden();
  await expect
    .poll(() => hmrMessages.some((message) => message.includes('"connected"')))
    .toBe(true);

  await page.evaluate(() =>
    localStorage.setItem("p4deck.dev-test", "retained"),
  );
  await page.reload();
  await expect(page.locator(".file-workbench")).toBeVisible();
  await expect(page.locator(".startup-recovery")).toBeHidden();
  expect(
    await page.evaluate(() => localStorage.getItem("p4deck.dev-test")),
  ).toBe("retained");
  expect(errors).toEqual([]);
});

test("browser preview keeps normal conditional HTTP caching", async ({
  request,
}) => {
  const first = await request.get("/src/features/files/fileDecorations.ts");
  expect(first.status()).toBe(200);
  expect(first.headers()["cache-control"]).toBe("no-cache");
  const reopened = await request.get("/src/features/files/fileDecorations.ts", {
    headers: { "If-None-Match": first.headers().etag },
  });
  expect(reopened.status()).toBe(304);
});
