import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  isTauri: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: api.isTauri }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: api.open }));

import { canPickExecutables, pickExecutablePath } from "./executablePicker";

beforeEach(() => {
  api.isTauri.mockReset();
  api.open.mockReset();
});

it("returns the selected executable path with a single-file .exe filter", async () => {
  api.isTauri.mockReturnValue(true);
  api.open.mockResolvedValue("C:\\Tools\\p4.exe");
  await expect(pickExecutablePath()).resolves.toBe("C:\\Tools\\p4.exe");
  expect(api.open).toHaveBeenCalledExactlyOnceWith({
    multiple: false,
    directory: false,
    filters: [{ name: "Executable", extensions: ["exe"] }],
  });
});

it("cancel (null) keeps the field unchanged and resolves undefined", async () => {
  api.isTauri.mockReturnValue(true);
  api.open.mockResolvedValue(null);
  await expect(pickExecutablePath()).resolves.toBeUndefined();
});

it("a plugin/capability error is swallowed and resolves undefined", async () => {
  api.isTauri.mockReturnValue(true);
  api.open.mockRejectedValue(Error("dialog not allowed"));
  await expect(pickExecutablePath()).resolves.toBeUndefined();
});

it("non-Tauri windows never open the dialog and report the picker unavailable", async () => {
  api.isTauri.mockReturnValue(false);
  await expect(pickExecutablePath()).resolves.toBeUndefined();
  await expect(canPickExecutables()).resolves.toBe(false);
  expect(api.open).not.toHaveBeenCalled();
});

it("exposes picker availability only when the desktop plugin loads", async () => {
  api.isTauri.mockReturnValue(true);
  await expect(canPickExecutables()).resolves.toBe(true);
});
