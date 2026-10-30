// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ConnectionProfiles,
  ConnectionStatus,
  RuntimeInfo,
} from "../../shared/contracts";
import { ConnectionProfilesCard } from "./ConnectionProfilesCard";

const api = vi.hoisted(() => ({ isTauri: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: api.isTauri }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: api.open }));
const backend = vi.hoisted(() => ({
  listConnectionProfiles: vi.fn(),
  cancelOperation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));

const status: ConnectionStatus = {
  state: "connected",
  message: "",
  recovery: "none",
  server: "ssl:fixture:1666",
};
const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "Rev. P4/TEST/2026.1",
  activeProfileId: "primary",
  contextGeneration: 1,
  context: {
    executable: "C:\\fixture\\p4.exe",
    server: "ssl:fixture:1666",
    user: "tester",
    client: "fixture-client",
    cwd: "C:\\fixture\\workspace",
  },
  connection: status,
};
const profiles: ConnectionProfiles = {
  schemaVersion: 3,
  revision: 4,
  activeProfileId: "primary",
  profiles: [
    {
      id: "primary",
      name: "Primary",
      context: {
        executable: "C:\\fixture\\p4.exe",
        server: "ssl:fixture:1666",
        user: "tester",
        client: "fixture-client",
        cwd: "C:\\fixture\\workspace",
      },
    },
  ],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  api.isTauri.mockReset();
  api.open.mockReset();
  backend.listConnectionProfiles.mockReset().mockResolvedValue(profiles);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(locale: "zh-CN" | "en-US" = "zh-CN") {
  await act(async () => {
    root.render(
      <ConnectionProfilesCard
        runtime={runtime}
        onConnection={vi.fn()}
        onRuntime={vi.fn()}
        locale={locale}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const input = (label: string) =>
  host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const pickerButton = (label: string) =>
  host
    .querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    .closest(".connection-field")!
    .querySelector<HTMLButtonElement>(".connection-field-actions button")!;
const exePickerButtons = () =>
  [
    ...host.querySelectorAll<HTMLButtonElement>(
      ".connection-field-actions button",
    ),
  ].filter((button) => button.title.includes(".exe"));

it("desktop: adds browse buttons for P4 executable and custom submit tool only", async () => {
  api.isTauri.mockReturnValue(true);
  await render();
  expect(exePickerButtons()).toHaveLength(2);
  expect(pickerButton("P4 可执行文件").textContent).toContain("浏览");
  expect(pickerButton("自定义提交工具（可选）").textContent).toContain("浏览");
  expect(pickerButton("P4 可执行文件").title).toContain(".exe");
});

it("picking fills the matching input without saving", async () => {
  api.isTauri.mockReturnValue(true);
  await render();
  api.open.mockResolvedValue("D:\\Tools\\p4-custom.exe");
  await act(async () => {
    pickerButton("P4 可执行文件").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(input("P4 可执行文件").value).toBe("D:\\Tools\\p4-custom.exe");
  expect(backend.listConnectionProfiles).toHaveBeenCalledTimes(1);
  api.open.mockResolvedValue("D:\\Tools\\submit.exe");
  await act(async () => {
    pickerButton("自定义提交工具（可选）").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(input("自定义提交工具（可选）").value).toBe("D:\\Tools\\submit.exe");
});

it("cancel or a dialog failure leaves the field unchanged and shows no error", async () => {
  api.isTauri.mockReturnValue(true);
  await render();
  const before = input("P4 可执行文件").value;
  api.open.mockResolvedValue(null);
  await act(async () => {
    pickerButton("P4 可执行文件").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(input("P4 可执行文件").value).toBe(before);
  api.open.mockRejectedValue(Error("denied"));
  await act(async () => {
    pickerButton("P4 可执行文件").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(input("P4 可执行文件").value).toBe(before);
  expect(host.textContent ?? "").not.toContain("denied");
});

it("browser/non-Tauri windows render no picker buttons", async () => {
  api.isTauri.mockReturnValue(false);
  await render();
  expect(pickerButton("P4 可执行文件")).toBeNull();
  expect(pickerButton("自定义提交工具（可选）")).toBeNull();
  expect(exePickerButtons()).toHaveLength(0);
  expect(api.open).not.toHaveBeenCalled();
});
