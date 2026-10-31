// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { activeSetupKey, ConnectionSetupGate } from "./ConnectionSetupGate";
import type { RuntimeInfo, ConnectionProfiles } from "../../shared/contracts";
import type { Preferences } from "../../app/hooks/usePreferences";
import type { useRuntime } from "../../app/hooks/useRuntime";
const backend = vi.hoisted(() => ({ listConnectionProfiles: vi.fn() }));
const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn() }));
vi.mock("../../infrastructure/backend", () => ({ backend }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.enabled,
  invoke: native.invoke,
}));
vi.mock("./ConnectionProfilesCard", () => ({
  ConnectionProfilesCard: () => (
    <div data-testid="settings">Existing connection settings</div>
  ),
}));
vi.mock("../../app/shell/AppControls", () => ({ AppControls: () => null }));
const context = {
  server: "synthetic.invalid:1666",
  user: "fixture",
  client: "workspace",
};
const profile = { id: "a", name: "Fixture", context };
const profiles = (active = true): ConnectionProfiles => ({
  schemaVersion: 3,
  revision: 1,
  activeProfileId: active ? "a" : undefined,
  profiles: active ? [profile] : [],
});
const runtime = (
  active = true,
  state: RuntimeInfo["connection"]["state"] = "notTested",
): RuntimeInfo => ({
  mode: "tauri",
  p4Version: "mock",
  activeProfileId: active ? "a" : undefined,
  contextGeneration: active ? 1 : 0,
  context,
  connection: { state, message: "", recovery: "retry", server: context.server },
});
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  native.enabled = false;
  native.invoke.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  backend.listConnectionProfiles.mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

it.each([false, true])(
  "keeps the guide and settings mounted when close request accepted=%s",
  async (accepted) => {
    native.enabled = true;
    native.invoke.mockResolvedValue({ accepted });
    backend.listConnectionProfiles.mockResolvedValue(profiles(false));
    await render(runtime(false));
    const dialog = host.querySelector("dialog")!;
    expect(document.activeElement).toBe(dialog.querySelectorAll("button")[1]);
    await act(async () =>
      dialog.querySelector<HTMLButtonElement>("button")!.click(),
    );
    expect(native.invoke).toHaveBeenLastCalledWith("close_guard_request", {
      scope: "application",
    });
    expect(host.querySelector("dialog")).toBe(dialog);
    await act(async () =>
      dialog.querySelectorAll<HTMLButtonElement>("button")[1].click(),
    );
    const settings = host.querySelector('[data-testid="settings"]');
    await act(async () =>
      host.querySelector<HTMLButtonElement>("header button")!.click(),
    );
    expect(host.querySelector('[data-testid="settings"]')).toBe(settings);
  },
);
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(value: RuntimeInfo, zh = true) {
  await act(async () =>
    root.render(
      <ConnectionSetupGate
        state={
          {
            runtime: value,
            applyRuntime: vi.fn(),
            applyConnection: vi.fn(),
          } as unknown as ReturnType<typeof useRuntime>
        }
        preferences={{ zh, locale: zh ? "zh-CN" : "en-US" } as Preferences}
      >
        <div data-testid="work">Work area</div>
      </ConnectionSetupGate>,
    ),
  );
}
it("waits for async initialization without flashing a prompt or mounting work", async () => {
  await render({ ...runtime(false), p4Version: "loading" });
  expect(host.querySelector("dialog")).toBeNull();
  expect(host.querySelector('[data-testid="work"]')).toBeNull();
  expect(backend.listConnectionProfiles).not.toHaveBeenCalled();
});
it("blocks escape and opens settings without a modal loop or work area", async () => {
  backend.listConnectionProfiles.mockResolvedValue(profiles(false));
  await render(runtime(false));
  expect(document.activeElement).toBe(host.querySelector("dialog button"));
  const event = new Event("cancel", { bubbles: true, cancelable: true });
  host.querySelector("dialog")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  const button = host.querySelector("dialog button")!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(host.querySelector("dialog")).toBeNull();
  expect(host.querySelector('[data-testid="settings"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="work"]')).toBeNull();
});
it.each(["networkError", "ticketExpired", "cliMissing"] as const)(
  "keeps existing configured users out of first-use flow during %s",
  async (state) => {
    backend.listConnectionProfiles.mockResolvedValue(profiles());
    await render(runtime(true, state));
    expect(host.querySelector('[data-testid="work"]')).not.toBeNull();
  },
);
it("requires new configuration activation success, then reopens guide after deletion", async () => {
  backend.listConnectionProfiles.mockResolvedValue(profiles(false));
  await render(runtime(false));
  backend.listConnectionProfiles.mockResolvedValue(profiles());
  await render(runtime(true));
  expect(host.querySelector('[data-testid="work"]')).toBeNull();
  await render(runtime(true, "connected"));
  expect(host.querySelector('[data-testid="work"]')).not.toBeNull();
  backend.listConnectionProfiles.mockResolvedValue(profiles(false));
  await render({ ...runtime(false), contextGeneration: 2 });
  expect(host.querySelector('[data-testid="work"]')).toBeNull();
});
it("ignores late old-profile results after a context switch", async () => {
  let resolve!: (value: ConnectionProfiles) => void;
  backend.listConnectionProfiles.mockImplementationOnce(
    () =>
      new Promise<ConnectionProfiles>((r) => {
        resolve = r;
      }),
  );
  await render(runtime(true));
  backend.listConnectionProfiles.mockResolvedValue(profiles(false));
  await render(runtime(false), false);
  await act(async () => resolve(profiles()));
  expect(host.textContent).toContain("Configure P4");
  expect(host.querySelector('[data-testid="work"]')).toBeNull();
});
it("rejects a mismatched, missing or incomplete active profile", () => {
  expect(activeSetupKey(runtime(), profiles(false))).toBe("");
  expect(
    activeSetupKey(
      { ...runtime(), context: { ...context, client: "other" } },
      profiles(),
    ),
  ).toBe("");
  expect(
    activeSetupKey(runtime(), {
      ...profiles(),
      profiles: [{ ...profile, context: { ...context, client: "" } }],
    }),
  ).toBe("");
});
