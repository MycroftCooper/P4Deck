import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdates,
  downloadUpdate,
  installAndRestart,
  resetUpdateService,
  settleUpdateWatcher,
  startUpdateWatcher,
  updateFailureText,
  UPDATE_CHECK_INTERVAL_MS,
} from "./updateService";
import { updateStore, type UpdateSnapshot } from "./updateStore";
import { setLocale } from "../../shared/i18n";

const d = vi.hoisted(() => ({
  tauri: true,
  main: true,
  windows: false,
  check: vi.fn(),
  relaunch: vi.fn(),
  getVersion: vi.fn(async () => "0.1.6"),
  notifyFailure: vi.fn(),
  notifyUser: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => d.tauri }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: d.main ? "main" : "popout" }),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: d.getVersion }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: d.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: d.relaunch }));
vi.mock("../../shared/notice", () => ({
  notifyFailure: d.notifyFailure,
  notifyUser: d.notifyUser,
}));
vi.mock("./updaterClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./updaterClient")>();
  return { ...actual, isWindowsPlatform: () => d.windows };
});

type FakeUpdate = {
  currentVersion: string;
  version: string;
  body?: string;
  download: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function fakeUpdate(
  overrides: Partial<FakeUpdate> = {},
  events: (onEvent: (event: unknown) => void) => Promise<void> | void = (
    onEvent,
  ) => {
    // Plugin-shaped events: the adapter maps these to normalized kinds.
    onEvent({ event: "Started", data: { contentLength: 1000 } });
    onEvent({ event: "Progress", data: { chunkLength: 250 } });
    onEvent({ event: "Progress", data: { chunkLength: 500 } });
    onEvent({ event: "Finished" });
  },
): FakeUpdate {
  return {
    currentVersion: "0.1.6",
    version: "0.1.7",
    body: "Release notes",
    download: vi.fn(async (onEvent: (event: unknown) => void) =>
      events(onEvent),
    ),
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(async () => {
  d.tauri = true;
  d.main = true;
  d.windows = false;
  vi.clearAllMocks();
  d.getVersion.mockResolvedValue("0.1.6");
  d.check.mockResolvedValue(null);
  await resetUpdateService();
});

// The UI translates through the module-level locale.
beforeEach(() => {
  setLocale("zh-CN");
});

describe("startup and periodic checks", () => {
  it("does nothing outside Tauri", async () => {
    d.tauri = false;
    const stop = startUpdateWatcher();
    await Promise.resolve();
    expect(d.check).not.toHaveBeenCalled();
    expect(updateStore.getSnapshot().phase).toBe("idle");
    stop();
  });

  it("does not check from a detached window", async () => {
    d.main = false;
    await checkForUpdates();
    const stop = startUpdateWatcher();
    await Promise.resolve();
    expect(d.check).not.toHaveBeenCalled();
    stop();
  });

  it("stays idle and silent when no update is announced", async () => {
    const stop = startUpdateWatcher();
    await vi.waitFor(() => expect(d.check).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(updateStore.getSnapshot().phase).toBe("idle"),
    );
    expect(updateStore.getSnapshot().currentVersion).toBe("0.1.6");
    expect(d.notifyFailure).not.toHaveBeenCalled();
    stop();
  });

  it("announces the available version and release notes", async () => {
    d.check.mockResolvedValue(fakeUpdate());
    await checkForUpdates();
    expect(updateStore.getSnapshot()).toMatchObject({
      phase: "available",
      currentVersion: "0.1.6",
      version: "0.1.7",
      notes: "Release notes",
      downloadedBytes: 0,
      applied: false,
    });
  });

  it("checks again on the interval and stops with the cleanup", async () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    const stop = startUpdateWatcher(10);
    await vi.waitFor(() =>
      expect(d.check.mock.calls.length).toBeGreaterThan(1),
    );
    stop();
    // A check launched just before stop may still be awaiting the host; drain
    // it before capturing the settled count (otherwise it lands after capture
    // and the count grows by one under a loaded CI worker).
    await settleUpdateWatcher();
    const settled = d.check.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(d.check.mock.calls.length).toBe(settled);
  });

  it("drains an in-flight interval check so the count cannot grow after stop", async () => {
    // Slow version lookup keeps the last launched check in flight past stop().
    d.getVersion.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("0.1.6"), 60)),
    );
    const stop = startUpdateWatcher(10);
    await vi.waitFor(() =>
      expect(d.check.mock.calls.length).toBeGreaterThan(1),
    );
    stop();
    await settleUpdateWatcher();
    const settled = d.check.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(d.check.mock.calls.length).toBe(settled);
  });

  it("keeps automatic check failures silent but reports manual ones", async () => {
    d.check.mockRejectedValue(new Error("offline"));
    await checkForUpdates();
    expect(updateStore.getSnapshot().phase).toBe("idle");
    expect(d.notifyFailure).not.toHaveBeenCalled();

    await checkForUpdates({ manual: true, zh: true });
    expect(updateStore.getSnapshot().phase).toBe("error");
    expect(updateStore.getSnapshot().errorScope).toBe("check");
    expect(d.notifyFailure).toHaveBeenCalledOnce();
  });

  it("tells a manual check that the app is already current", async () => {
    await checkForUpdates({ manual: true, zh: true });
    expect(updateStore.getSnapshot().phase).toBe("idle");
    expect(d.notifyUser).toHaveBeenCalledWith("已是最新版本 v0.1.6。");
  });
});

describe("download, install confirmation and restart", () => {
  it("downloads with progress and stops at ready without installing", async () => {
    const update = fakeUpdate();
    d.check.mockResolvedValue(update);
    await checkForUpdates();
    const seen: UpdateSnapshot[] = [];
    const unsubscribe = updateStore.subscribe(() =>
      seen.push(updateStore.getSnapshot()),
    );
    await downloadUpdate();
    unsubscribe();

    expect(seen.map((state) => state.phase)).toEqual(
      expect.arrayContaining(["downloading", "ready"]),
    );
    expect(seen.some((state) => state.downloadedBytes === 250)).toBe(true);
    expect(updateStore.getSnapshot()).toMatchObject({
      phase: "ready",
      totalBytes: 1000,
      downloadedBytes: 1000,
      applied: false,
    });
    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
  });

  it("installs only after confirmation, then relaunches off Windows", async () => {
    const update = fakeUpdate();
    d.check.mockResolvedValue(update);
    await checkForUpdates();
    await downloadUpdate();
    expect(update.install).not.toHaveBeenCalled();

    await installAndRestart();
    expect(update.install).toHaveBeenCalledOnce();
    expect(d.relaunch).toHaveBeenCalledOnce();
    expect(updateStore.getSnapshot()).toMatchObject({
      phase: "restarting",
      applied: true,
    });
  });

  it("lets the Windows installer restart and never calls JS relaunch", async () => {
    d.windows = true;
    const update = fakeUpdate();
    d.check.mockResolvedValue(update);
    await checkForUpdates();
    await downloadUpdate();
    await installAndRestart();
    expect(update.install).toHaveBeenCalledOnce();
    expect(d.relaunch).not.toHaveBeenCalled();
    expect(updateStore.getSnapshot()).toMatchObject({ applied: true });
  });

  it("does not check or install while a downloaded update waits", async () => {
    const update = fakeUpdate();
    d.check.mockResolvedValue(update);
    await checkForUpdates();
    await downloadUpdate();
    d.check.mockClear();
    await checkForUpdates();
    expect(d.check).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
  });

  it("shows a localized download failure instead of a fake success", async () => {
    d.check.mockResolvedValue(
      fakeUpdate({
        download: vi.fn(async () => {
          throw new Error("error sending request: connection refused");
        }),
      }),
    );
    await checkForUpdates();
    await downloadUpdate();
    expect(updateStore.getSnapshot()).toMatchObject({
      phase: "error",
      errorScope: "download",
      applied: false,
    });
    expect(d.notifyFailure).toHaveBeenCalledOnce();
    expect(d.notifyFailure.mock.calls[0][0]).toBeUndefined();
    expect(d.notifyFailure.mock.calls[0][1]).toEqual({
      zh: "无法连接更新服务器；请检查网络后重试。",
      en: "Could not reach the update server. Check your network and retry.",
    });
  });

  it("reports an install failure without claiming success", async () => {
    const update = fakeUpdate({
      install: vi.fn(async () => {
        throw new Error("Access is denied");
      }),
    });
    d.check.mockResolvedValue(update);
    await checkForUpdates();
    await downloadUpdate();
    await installAndRestart();
    expect(update.install).toHaveBeenCalledOnce();
    expect(d.relaunch).not.toHaveBeenCalled();
    expect(updateStore.getSnapshot()).toMatchObject({
      phase: "error",
      errorScope: "install",
      applied: false,
    });
    expect(d.notifyFailure).toHaveBeenCalledOnce();
    expect(d.notifyFailure.mock.calls[0][1]).toEqual({
      zh: "系统拒绝安装更新（可能需要管理员权限）；请手动安装。",
      en: "The system refused to install the update (administrator rights may be required). Install it manually.",
    });
  });

  it("keeps the installed state and asks for a manual restart when relaunch fails", async () => {
    const update = fakeUpdate();
    d.check.mockResolvedValue(update);
    d.relaunch.mockRejectedValueOnce(new Error("relaunch denied"));
    await checkForUpdates();
    await downloadUpdate();
    await installAndRestart();
    expect(update.install).toHaveBeenCalledOnce();
    expect(updateStore.getSnapshot()).toMatchObject({
      phase: "error",
      errorScope: "restart",
      applied: true,
    });
    expect(d.notifyFailure).toHaveBeenCalledOnce();
    expect(d.notifyFailure.mock.calls[0][1]).toEqual({
      zh: "更新已安装，但自动重启失败；请手动重启 P4Deck 完成更新。",
      en: "The update is installed, but the automatic restart failed. Restart P4Deck manually to finish updating.",
    });
  });

  it("ignores download and install attempts without an announced update", async () => {
    await downloadUpdate();
    await installAndRestart();
    expect(updateStore.getSnapshot().phase).toBe("idle");
    expect(updateStore.getSnapshot().applied).toBe(false);
    expect(d.check).not.toHaveBeenCalled();
  });
});

describe("verification failure copy", () => {
  it("keeps a neutral copy for check and download failures", () => {
    expect(
      updateFailureText("signature verification failed", "check", true),
    ).toBe("更新包校验失败；请稍后重试或手动下载安装包。");
    expect(
      updateFailureText("signature verification failed", "download", true),
    ).toBe("更新包校验失败；请稍后重试或手动下载安装包。");
    expect(
      updateFailureText("signature verification failed", "check", false),
    ).toBe(
      "The update package failed verification. Retry later or download the installer manually.",
    );
    expect(
      updateFailureText("signature verification failed", "check", true),
    ).not.toContain("安装已取消");
  });

  it("keeps the install-cancelled copy when installation itself fails", () => {
    expect(
      updateFailureText("signature verification failed", "install", true),
    ).toBe("更新包校验失败，安装已取消；请稍后重试或手动下载安装包。");
    expect(
      updateFailureText("signature verification failed", "install", false),
    ).toBe(
      "The update package failed verification and installation was cancelled. Retry later or download the installer manually.",
    );
  });

  it("reports the neutral copy when the signed manifest fails during check", async () => {
    d.check.mockRejectedValue(new Error("signature verification failed"));
    await checkForUpdates({ manual: true, zh: true });
    expect(d.notifyFailure.mock.calls[0][1]).toEqual({
      zh: "更新包校验失败；请稍后重试或手动下载安装包。",
      en: "The update package failed verification. Retry later or download the installer manually.",
    });
  });
});
