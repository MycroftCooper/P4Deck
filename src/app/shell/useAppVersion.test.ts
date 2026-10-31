import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  isTauri: vi.fn(),
  getVersion: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: api.isTauri }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: api.getVersion }));

import { loadAppVersion, resetAppVersionCacheForTests } from "./useAppVersion";

beforeEach(() => {
  api.isTauri.mockReset();
  api.getVersion.mockReset();
  resetAppVersionCacheForTests();
});

it("returns the real desktop version and caches a single request", async () => {
  api.isTauri.mockReturnValue(true);
  api.getVersion.mockResolvedValue("0.1.9");
  await expect(loadAppVersion()).resolves.toBe("0.1.9");
  await expect(loadAppVersion()).resolves.toBe("0.1.9");
  expect(api.getVersion).toHaveBeenCalledTimes(1);
});

it("browser/non-Tauri never calls the app module and resolves undefined", async () => {
  api.isTauri.mockReturnValue(false);
  await expect(loadAppVersion()).resolves.toBeUndefined();
  expect(api.getVersion).not.toHaveBeenCalled();
});

it("a failed version lookup degrades to undefined without throwing", async () => {
  api.isTauri.mockReturnValue(true);
  api.getVersion.mockRejectedValue(Error("ipc unavailable"));
  await expect(loadAppVersion()).resolves.toBeUndefined();
});
