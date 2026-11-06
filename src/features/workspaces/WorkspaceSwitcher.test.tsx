// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RuntimeInfo } from "../../shared/contracts";
import { TopBar } from "../../app/shell/TopBar";

const backend = vi.hoisted(() => ({
  listUserWorkspaces: vi.fn(),
  switchWorkspace: vi.fn(),
  runtimeInfo: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));
const initial: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  contextGeneration: 7,
  context: { server: "fixture:1666", user: "tester", client: "main-client" },
  connection: {
    state: "notTested",
    message: "not tested",
    recovery: "retry",
    server: "fixture:1666",
  },
};
const items = ["main-client", "dev-client"].map((name) => ({
  name,
  owner: "tester",
  root: `C:\\work\\${name}`,
  host: "WIN",
  stream: "",
  description: "",
  updated: null,
  accessed: null,
}));
let host: HTMLDivElement;
let root: Root;
const applied = vi.fn();
const settings = vi.fn();
const trigger = () => host.querySelector<HTMLButtonElement>(".connection")!;
const item = (name: string) =>
  [
    ...host.querySelectorAll<HTMLButtonElement>(".workspace-switcher-item"),
  ].find((button) => button.textContent?.includes(name))!;
async function render(runtime = initial) {
  await act(async () =>
    root.render(
      <TopBar runtime={runtime} zh onRuntime={applied} onSettings={settings} />,
    ),
  );
}
async function open() {
  await act(async () => trigger().click());
}
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  backend.listUserWorkspaces.mockResolvedValue(items);
  backend.switchWorkspace.mockReset();
  backend.runtimeInfo.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("opens a lazy workspace dropdown even when connectivity has not yet been tested", async () => {
  await render();
  expect(backend.listUserWorkspaces).not.toHaveBeenCalled();
  await open();
  expect(settings).not.toHaveBeenCalled();
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(item("main-client").getAttribute("aria-current")).toBe("true");
  expect(document.activeElement).toBe(host.querySelector("input"));
  await act(async () => item("main-client").click());
  expect(backend.switchWorkspace).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger());
});

it("switches through the existing generation-checked backend and applies only its returned runtime", async () => {
  let resolve!: (runtime: RuntimeInfo) => void;
  backend.switchWorkspace.mockReturnValue(
    new Promise<RuntimeInfo>((done) => {
      resolve = done;
    }),
  );
  await render();
  await open();
  await act(async () => item("dev-client").click());
  expect(backend.switchWorkspace).toHaveBeenCalledWith({
    expectedGeneration: 7,
    client: "dev-client",
  });
  expect(applied).not.toHaveBeenCalled();
  expect(item("main-client").disabled).toBe(true);
  const next = {
    ...initial,
    contextGeneration: 8,
    context: { ...initial.context, client: "dev-client" },
  };
  await act(async () => resolve(next));
  expect(applied).toHaveBeenCalledWith(next);
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await render(next);
  const switchedTrigger = trigger();
  expect(document.activeElement).toBe(switchedTrigger);
  await render({
    ...next,
    connection: { ...next.connection, state: "connected" },
  });
  expect(trigger()).toBe(switchedTrigger);
  expect(document.activeElement).toBe(switchedTrigger);
});

it("preserves the active workspace and shows recovery on switch failure", async () => {
  backend.switchWorkspace.mockRejectedValue({ code: "connectionFailed" });
  await render();
  await open();
  await act(async () => item("dev-client").click());
  expect(applied).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "检查 Server、Client 与 Root",
  );
  expect(trigger().textContent).toContain("main-client");
  expect(item("dev-client").disabled).toBe(false);
});

it("supports arrow navigation, Escape, outside click and an explicit settings entry", async () => {
  await render();
  await open();
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(item("main-client"));
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(trigger());
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await open();
  await act(async () =>
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })),
  );
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await open();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(".workspace-switcher-settings")!
      .click(),
  );
  expect(settings).toHaveBeenCalledOnce();
});

it("can retry a failed list request without leaving the current page", async () => {
  backend.listUserWorkspaces.mockRejectedValueOnce(new Error("offline"));
  await render();
  await open();
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="刷新 Workspace"]')!
      .click(),
  );
  expect(item("dev-client")).toBeTruthy();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("discards old list and switch responses when another connection becomes active", async () => {
  let resolveList!: (data: typeof items) => void;
  backend.listUserWorkspaces.mockReturnValueOnce(
    new Promise<typeof items>((resolve) => {
      resolveList = resolve;
    }),
  );
  await render();
  await open();
  const next = {
    ...initial,
    contextGeneration: 8,
    context: { ...initial.context, client: "other-client" },
  };
  await render(next);
  await act(async () => resolveList(items));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(trigger().textContent).toContain("other-client");
  await render();
  await open();
  let resolveSwitch!: (data: RuntimeInfo) => void;
  backend.switchWorkspace.mockReturnValue(
    new Promise<RuntimeInfo>((resolve) => {
      resolveSwitch = resolve;
    }),
  );
  await act(async () => item("dev-client").click());
  await render(next);
  await act(async () => resolveSwitch(initial));
  expect(applied).not.toHaveBeenCalled();
});

it("resynchronizes a stale generation once and retries the switch", async () => {
  const stale: RuntimeInfo = {
    ...initial,
    contextGeneration: 8,
    context: { ...initial.context, client: "other-client" },
  };
  const retried: RuntimeInfo = {
    ...stale,
    contextGeneration: 9,
    context: { ...stale.context, client: "dev-client" },
  };
  backend.switchWorkspace
    .mockRejectedValueOnce({ code: "contextChanged" })
    .mockResolvedValueOnce(retried);
  backend.runtimeInfo.mockResolvedValue(stale);
  await render();
  await open();
  await act(async () => item("dev-client").click());
  expect(backend.switchWorkspace).toHaveBeenNthCalledWith(1, {
    expectedGeneration: 7,
    client: "dev-client",
  });
  expect(backend.runtimeInfo).toHaveBeenCalledOnce();
  expect(backend.switchWorkspace).toHaveBeenNthCalledWith(2, {
    expectedGeneration: 8,
    client: "dev-client",
  });
  expect(applied).toHaveBeenCalledWith(retried);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("applies the resynchronized runtime without retrying across connections", async () => {
  const other: RuntimeInfo = {
    ...initial,
    activeProfileId: "other-profile",
    contextGeneration: 9,
  };
  backend.switchWorkspace.mockRejectedValue({ code: "contextChanged" });
  backend.runtimeInfo.mockResolvedValue(other);
  await render();
  await open();
  await act(async () => item("dev-client").click());
  expect(backend.switchWorkspace).toHaveBeenCalledOnce();
  expect(applied).toHaveBeenCalledWith(other);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "已重新同步连接状态",
  );
});
