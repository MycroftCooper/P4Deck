// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { pageIds } from "../panels";
import {
  pageSessionPayload,
  readPageSession,
  sanitizeSessionPages,
  sessionForWindow,
  usePageNavigation,
} from "./usePageNavigation";
import type { PageId } from "../panels";

const KEY = "p4deck.pages";
let host: HTMLDivElement;
let root: Root;
let nav: ReturnType<typeof usePageNavigation>;
function Probe() {
  nav = usePageNavigation();
  return createElement("div", {
    "data-pages": nav.pages.join(","),
    "data-route": nav.route ?? "",
  });
}
async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  return nav;
}
async function unmount() {
  await act(async () => root.unmount());
  host.remove();
  root = undefined as unknown as Root;
  host = undefined as unknown as HTMLDivElement;
}
function stored(): {
  version?: number;
  pages?: string[];
  active?: string | null;
} {
  return JSON.parse(localStorage.getItem(KEY) ?? "null");
}
beforeEach(() => {
  localStorage.clear();
  // Clear any hash left by a previous test so deep links do not mask the session.
  history.replaceState(null, "", "/");
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});

it("first launch opens Pending only and never the other pages", async () => {
  await mount();
  expect(nav.pages).toEqual(["pending"]);
  expect(nav.route).toBe("pending");
  expect(nav.pages).not.toContain("files");
  expect(nav.pages).not.toContain("submitted");
  expect(nav.pages).not.toContain("settings");
  expect(stored()).toMatchObject({
    version: 1,
    pages: ["pending"],
    active: "pending",
  });
});

it("restores the previously open set plus the active page", async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      version: 1,
      pages: ["pending", "files", "settings"],
      active: "files",
    }),
  );
  await mount();
  expect(nav.pages).toEqual(["pending", "files", "settings"]);
  expect(nav.route).toBe("files");
});

it("drops unknown page ids and falls back to the first open page", async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      version: 1,
      pages: ["pending", "no-such-page", "files", "files"],
      active: "no-such-page",
    }),
  );
  await mount();
  expect(nav.pages).toEqual(["pending", "files"]);
  expect(nav.route).toBe("pending");
});

it("falls back to Pending for empty, corrupt and unknown-version sessions", async () => {
  for (const raw of [
    "",
    "broken",
    "null",
    JSON.stringify({ version: 1, pages: [] }),
    JSON.stringify({ version: 99, pages: ["files"], active: "files" }),
    JSON.stringify(["no-such-page"]),
  ]) {
    localStorage.setItem(KEY, raw);
    await mount();
    expect(nav.pages).toEqual(["pending"]);
    expect(nav.route).toBe("pending");
    await unmount();
  }
});

it("caps an abnormal restored session at 12 tabs", async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      version: 1,
      pages: [...pageIds, ...pageIds],
      active: "pending",
    }),
  );
  await mount();
  expect(nav.pages.length).toBe(12);
  expect(pageIds).toEqual(expect.arrayContaining(nav.pages));
});

it("closing a page updates the session, and the next start restores it", async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      version: 1,
      pages: ["pending", "files"],
      active: "files",
    }),
  );
  await mount();
  expect(nav.route).toBe("files");
  // Dockview publishes the remaining panels and then the new active panel, like
  // closing the active tab does in the real workspace.
  await act(async () => {
    nav.setPages(["pending"]);
    nav.onActive("pending");
  });
  expect(stored()).toMatchObject({ pages: ["pending"], active: "pending" });
  await unmount();
  await mount();
  expect(nav.pages).toEqual(["pending"]);
  expect(nav.route).toBe("pending");
});

it("restart is idempotent: unchanged sessions are restored byte-for-byte", async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      version: 1,
      pages: ["pending", "files", "settings"],
      active: "settings",
    }),
  );
  await mount();
  const first = localStorage.getItem(KEY);
  await unmount();
  await mount();
  expect(localStorage.getItem(KEY)).toBe(first);
  expect(nav.pages).toEqual(["pending", "files", "settings"]);
  expect(nav.route).toBe("settings");
});

it("persists a new active page without changing the open set", async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      version: 1,
      pages: ["pending", "files"],
      active: "pending",
    }),
  );
  await mount();
  await act(async () => nav.onActive("files"));
  expect(stored()).toMatchObject({
    pages: ["pending", "files"],
    active: "files",
  });
});

it("keeps legacy array sessions working (active = first page)", () => {
  expect(readPageSession('["files","pending"]')).toMatchObject({
    pages: ["files", "pending"],
    active: "files",
    source: "legacy",
  });
});

it("sanitizes and clamps session payloads", () => {
  expect(sanitizeSessionPages(["pending", "bogus", "pending"])).toEqual([
    "pending",
  ]);
  expect(
    JSON.parse(pageSessionPayload(["pending", "files"], "settings" as PageId)),
  ).toEqual({ version: 1, pages: ["pending", "files"], active: "pending" });
  expect(JSON.parse(pageSessionPayload([], null))).toEqual({
    version: 1,
    pages: [],
    active: null,
  });
});

it("detached/panel windows keep only their own page and never persist", () => {
  const windowSession = sessionForWindow(
    JSON.stringify({
      version: 1,
      pages: ["pending", "files"],
      active: "files",
    }),
    "files",
  );
  expect(windowSession).toEqual({
    pages: ["files"],
    active: "files",
    source: "default",
    persist: false,
  });
  expect(sessionForWindow(null, "no-such-panel").pages).toEqual(["pending"]);
  expect(sessionForWindow(null, null).persist).toBe(true);
});

it("writes the session in the main window (detached branch is covered above)", async () => {
  await mount();
  expect(localStorage.getItem(KEY)).not.toBeNull();
});
