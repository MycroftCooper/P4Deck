// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogButton, dialogHarness } from "../dialogs/testHarness";
import { UpdatePanel } from "./UpdatePanel";
import { closeUpdatePanel, openUpdatePanel } from "./updatePanelStore";
import {
  checkForUpdates,
  downloadUpdate,
  installAndRestart,
  resetUpdateService,
} from "./updateService";
import { updateStore } from "./updateStore";

const d = vi.hoisted(() => ({
  windows: false,
  checkForUpdate: vi.fn(),
  relaunchApp: vi.fn(async () => {}),
  currentAppVersion: vi.fn(async () => "0.1.6"),
  isMainWindow: vi.fn(() => true),
  notifyFailure: vi.fn(),
  notifyUser: vi.fn(),
}));

vi.mock("./updaterClient", () => ({
  checkForUpdate: d.checkForUpdate,
  relaunchApp: d.relaunchApp,
  currentAppVersion: d.currentAppVersion,
  isMainWindow: d.isMainWindow,
  isWindowsPlatform: () => d.windows,
}));
vi.mock("../../shared/notice", () => ({
  notifyFailure: d.notifyFailure,
  notifyUser: d.notifyUser,
}));

type DownloadProgress =
  | { kind: "started"; contentLength?: number }
  | { kind: "progress"; chunkLength: number }
  | { kind: "finished" };

function pendingUpdate(
  events: (
    onEvent: (event: DownloadProgress) => void,
  ) => Promise<void> = async (onEvent) => {
    onEvent({ kind: "started", contentLength: 1000 });
    onEvent({ kind: "progress", chunkLength: 500 });
    onEvent({ kind: "finished" });
  },
  install: () => Promise<void> = async () => {},
) {
  return {
    currentVersion: "0.1.6",
    version: "0.1.7",
    notes: "修复若干问题，改进更新流程。",
    download: vi.fn(events),
    install: vi.fn(install),
    close: vi.fn(async () => {}),
  };
}

const h = dialogHarness();

const dialog = () => document.querySelector("dialog")!;
const dialogText = () => dialog().textContent ?? "";

async function openWith(
  phase: "available" | "idle" | "downloaded" = "available",
  update = pendingUpdate(),
) {
  if (phase !== "idle") {
    d.checkForUpdate.mockResolvedValue(update);
    await act(async () => {
      await checkForUpdates();
    });
  }
  if (phase === "downloaded") {
    await act(async () => {
      await downloadUpdate();
    });
  }
  await act(async () => {
    openUpdatePanel();
  });
  await h.render(<UpdatePanel zh />);
  return update;
}

beforeEach(async () => {
  vi.clearAllMocks();
  d.windows = false;
  closeUpdatePanel();
  await resetUpdateService();
  d.isMainWindow.mockReturnValue(true);
  d.currentAppVersion.mockResolvedValue("0.1.6");
});

it("renders the announced version and downloads on request without installing", async () => {
  await openWith();
  expect(dialogText()).toContain("发现新版本 v0.1.7");
  expect(dialogText()).toContain("当前版本");
  expect(dialogText()).toContain("0.1.6");
  expect(dialogText()).toContain("修复若干问题");
  await act(async () => {
    dialogButton("下载更新").click();
  });
  expect(updateStore.getSnapshot().phase).toBe("ready");
  expect(dialogText()).toContain("更新已下载");
  expect(dialogText()).toContain("尚未安装");
  expect(dialogButton("立即安装后重启")).toBeTruthy();
  expect(dialogButton("稍后")).toBeTruthy();
});

it("shows download percentage while the package is being fetched", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const update = pendingUpdate(async (onEvent) => {
    onEvent({ kind: "started", contentLength: 1000 });
    onEvent({ kind: "progress", chunkLength: 500 });
    await gate;
    onEvent({ kind: "finished" });
  });
  d.checkForUpdate.mockResolvedValue(update);
  await act(async () => {
    await checkForUpdates();
  });
  await act(async () => {
    openUpdatePanel();
  });
  await h.render(<UpdatePanel zh />);
  await act(async () => {
    void downloadUpdate();
    await Promise.resolve();
  });
  expect(dialogText()).toContain("50%");
  expect(
    dialog()
      .querySelector('[role="progressbar"]')
      ?.getAttribute("aria-valuenow"),
  ).toBe("50");
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await vi.waitFor(() => expect(updateStore.getSnapshot().phase).toBe("ready"));
  expect(dialogText()).toContain("尚未安装");
});

it("keeps the downloaded update when postponed, then installs and relaunches", async () => {
  const update = await openWith("downloaded");
  expect(update.install).not.toHaveBeenCalled();
  await act(async () => {
    dialogButton("稍后").click();
  });
  expect(document.querySelector("dialog")).toBeNull();
  expect(updateStore.getSnapshot()).toMatchObject({
    phase: "ready",
    applied: false,
  });
  expect(update.install).not.toHaveBeenCalled();

  await act(async () => {
    openUpdatePanel();
  });
  await h.render(<UpdatePanel zh />);
  await act(async () => {
    dialogButton("立即安装后重启").click();
  });
  expect(update.install).toHaveBeenCalledOnce();
  expect(d.relaunchApp).toHaveBeenCalledOnce();
  expect(updateStore.getSnapshot()).toMatchObject({
    phase: "restarting",
    applied: true,
  });
});

it("labels the Windows confirmation as install-and-restart", async () => {
  d.windows = true;
  const update = await openWith("downloaded");
  expect(dialogButton("立即安装并重启")).toBeTruthy();
  await act(async () => {
    dialogButton("立即安装并重启").click();
  });
  expect(update.install).toHaveBeenCalledOnce();
  expect(d.relaunchApp).not.toHaveBeenCalled();
});

it("shows the download failure reason instead of a fake success", async () => {
  d.checkForUpdate.mockResolvedValue(
    pendingUpdate(async () => {
      throw new Error("error sending request: connection refused");
    }),
  );
  await act(async () => {
    await checkForUpdates();
    await downloadUpdate();
  });
  expect(updateStore.getSnapshot().phase).toBe("error");
  await act(async () => {
    openUpdatePanel();
  });
  await h.render(<UpdatePanel zh />);
  expect(dialogText()).toContain("无法连接更新服务器");
  expect(dialogText()).toContain("error sending request: connection refused");
  expect(dialogText()).not.toContain("更新已下载");
  expect(dialogButton("重新检查")).toBeTruthy();
});

it("shows the install failure reason and never claims the update applied", async () => {
  d.checkForUpdate.mockResolvedValue(
    pendingUpdate(undefined, async () => {
      throw new Error("Access is denied");
    }),
  );
  await act(async () => {
    await checkForUpdates();
    await downloadUpdate();
    await installAndRestart();
  });
  expect(updateStore.getSnapshot()).toMatchObject({
    phase: "error",
    errorScope: "install",
    applied: false,
  });
  await act(async () => {
    openUpdatePanel();
  });
  await h.render(<UpdatePanel zh />);
  expect(dialogText()).toContain("系统拒绝安装更新");
  expect(dialogText()).toContain("Access is denied");
  expect(dialogText()).not.toContain("更新已安装");
  expect(dialogButton("重新检查")).toBeTruthy();
});

it("reports the current version when there is nothing to install", async () => {
  await openWith("idle");
  expect(dialogText()).toContain("当前已是最新版本");
  expect(dialog().querySelector('[aria-label="关闭对话框"]')).toBeTruthy();
});
