// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogButton, dialogHarness } from "../../app/dialogs/testHarness";
import { setLocale } from "../../shared/i18n";
import { UpdateSettingsCard } from "./UpdateSettingsCard";

const service = vi.hoisted(() => ({ checkForUpdates: vi.fn() }));
const backend = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async (_url: string) => {}),
}));

vi.mock("../../app/update/updateService", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../app/update/updateService")>();
  return { ...actual, checkForUpdates: service.checkForUpdates };
});
vi.mock("../../infrastructure/backend", () => ({ backend }));

const PRODUCT_PAGE = "https://mycroftcooper.github.io/P4Deck/";
const WIKI = "https://mycroftcooper.github.io/P4Deck/wiki/";

const h = dialogHarness();

beforeEach(() => {
  setLocale("en-US");
  service.checkForUpdates.mockReset();
  backend.openExternalUrl.mockReset();
  backend.openExternalUrl.mockResolvedValue(undefined);
});

function actionButton(name: string) {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(".settings-actions button"),
  ].find((button) => button.textContent?.includes(name))!;
}

it("opens the bundled changelog in the browser demo without an update check", async () => {
  await h.render(<UpdateSettingsCard zh={false} native={false} />);
  expect(document.querySelector("dialog")).toBeNull();
  // The changelog is local data, so the entrance stays usable where checks are not.
  expect(actionButton("View changelog").disabled).toBe(false);
  await act(async () => actionButton("View changelog").click());
  const dialog = document.querySelector("dialog")!;
  expect(dialog.textContent).toContain("Changelog");
  expect(dialog.textContent).toContain("v0.1.12");
  expect(service.checkForUpdates).not.toHaveBeenCalled();
  await act(async () => dialogButton("Close").click());
  expect(document.querySelector("dialog")).toBeNull();
});

it("never starts an update check in the desktop app either", async () => {
  await h.render(<UpdateSettingsCard zh native />);
  await act(async () => actionButton("View changelog").click());
  expect(document.querySelector("dialog")?.textContent).toContain("0.1.7");
  expect(service.checkForUpdates).not.toHaveBeenCalled();
});

it("opens the exact allowlisted product and wiki pages from the update module", async () => {
  await h.render(<UpdateSettingsCard zh={false} native={false} />);
  await act(async () => actionButton("Open product page").click());
  await act(async () => actionButton("Open wiki").click());
  expect(backend.openExternalUrl.mock.calls).toEqual([[PRODUCT_PAGE], [WIKI]]);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("reports a rejected product or wiki link inline", async () => {
  backend.openExternalUrl.mockRejectedValueOnce(new Error("blocked"));
  await h.render(<UpdateSettingsCard zh={false} native={false} />);
  await act(async () => actionButton("Open wiki").click());
  await act(async () => {
    await Promise.resolve();
  });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not open the link",
  );
});
