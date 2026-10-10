// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { messages } from "../../shared/i18n";
import type { RuntimeInfo } from "../../shared/contracts/types";
import { WorkspacePage } from "./WorkspacePage";

const backend = vi.hoisted(() => ({
  listUserWorkspaces: vi.fn(),
  switchWorkspace: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 48,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 48,
        size: 48,
      })),
  }),
}));

const initial: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  activeProfileId: "primary",
  contextGeneration: 7,
  context: {
    server: "fixture:1666",
    user: "tester",
    client: "main-client",
    cwd: "C:\\work\\main",
  },
  connection: {
    state: "connected",
    message: "connected",
    recovery: "none",
    server: "fixture:1666",
  },
};

const workspaces = [
  {
    name: "main-client",
    owner: "tester",
    host: "WIN",
    root: "C:\\work\\main",
    stream: "//depot/main",
    description: "Main",
    updated: 1,
    accessed: 1,
  },
  {
    name: "dev-client",
    owner: "tester",
    host: "WIN",
    root: "C:\\work\\dev",
    stream: "//depot/dev",
    description: "Dev",
    updated: 2,
    accessed: 2,
  },
];

let host: HTMLDivElement;
let root: Root;
const applied = vi.fn();

function Harness({ mode = "tauri" }: { mode?: RuntimeInfo["mode"] }) {
  const [runtime, setRuntime] = useState({ ...initial, mode });
  return (
    <WorkspacePage
      t={messages["zh-CN"]}
      runtime={runtime}
      onRuntime={(next) => {
        applied(next);
        setRuntime(next);
      }}
    />
  );
}

async function render(mode: RuntimeInfo["mode"] = "tauri") {
  await act(async () => {
    root.render(<Harness mode={mode} />);
    await Promise.resolve();
  });
}

function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  )!;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.listUserWorkspaces.mockReset().mockResolvedValue(workspaces);
  backend.switchWorkspace.mockReset();
  applied.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
});

it("shows the real current Client, Root, and Stream and marks Mock as simulated", async () => {
  await render("mock");
  expect(
    host.querySelector(".workspace-runtime-summary")?.textContent,
  ).toContain("main-client");
  expect(
    host.querySelector(".workspace-runtime-summary")?.textContent,
  ).toContain("C:\\work\\main");
  expect(
    host.querySelector(".workspace-runtime-summary")?.textContent,
  ).toContain("//depot/main");
  expect(host.textContent).toContain("Simulated Mock");
  expect(host.textContent).toContain("不访问真实网络");
});

it("does not query or offer refresh before the connection is verified", async () => {
  const notTested: RuntimeInfo = {
    ...initial,
    connection: {
      state: "notTested",
      message: "not tested",
      recovery: "retry",
      server: initial.context.server,
    },
  };
  await act(async () => {
    root.render(
      <WorkspacePage
        t={messages["zh-CN"]}
        runtime={notTested}
        onRuntime={applied}
      />,
    );
    await Promise.resolve();
  });
  expect(backend.listUserWorkspaces).not.toHaveBeenCalled();
  expect(button("刷新").disabled).toBe(true);
  expect(host.textContent).toContain("连接未验证时不会自动扫描 Workspace");
});

it("calls switchWorkspace with generation, exposes verify/commit/success, and applies returned runtime", async () => {
  vi.useFakeTimers();
  let resolveSwitch!: (runtime: RuntimeInfo) => void;
  backend.switchWorkspace.mockReturnValue(
    new Promise<RuntimeInfo>((resolve) => {
      resolveSwitch = resolve;
    }),
  );
  const next: RuntimeInfo = {
    ...initial,
    contextGeneration: 8,
    context: { ...initial.context, client: "dev-client", cwd: "C:\\work\\dev" },
  };
  await render();
  await act(async () => button("dev-client").click());
  await act(async () => {
    button("切换到此工作区").click();
    await Promise.resolve();
  });
  expect(backend.switchWorkspace).toHaveBeenCalledWith({
    expectedGeneration: 7,
    client: "dev-client",
  });
  expect(host.textContent).toContain("正在验证目标 Workspace");
  await act(async () => {
    resolveSwitch(next);
    await Promise.resolve();
  });
  expect(host.textContent).toContain("正在提交 Workspace");
  await act(async () => vi.runAllTimersAsync());
  expect(applied).toHaveBeenCalledWith(next);
  expect(host.textContent).toContain("已切换到 dev-client");
  expect(
    host.querySelector(".workspace-runtime-summary")?.textContent,
  ).toContain("C:\\work\\dev");
});

it("keeps the old runtime, detail, data, and focus when switching fails", async () => {
  backend.switchWorkspace.mockRejectedValue({
    code: "connectionFailed",
    message: "offline",
  });
  await render();
  await act(async () => button("dev-client").click());
  const switchButton = button("切换到此工作区");
  await act(async () => {
    switchButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(applied).not.toHaveBeenCalled();
  expect(host.textContent).toContain("仍保留 main-client 与现有页面数据");
  expect(host.textContent).toContain("切换失败，原 Workspace 保持不变");
  expect(host.textContent).toContain("Dev");
  expect(host.querySelector('[aria-current="true"]')).toBeNull();
  expect(document.activeElement).toBe(switchButton);
});

it("keeps row buttons keyboard focusable and provides polite switch status", async () => {
  await render();
  const row = button("dev-client");
  row.focus();
  expect(document.activeElement).toBe(row);
  expect(
    host.querySelector(
      '.workspace-switch-status[role="status"][aria-live="polite"]',
    ),
  ).toBeTruthy();
});
