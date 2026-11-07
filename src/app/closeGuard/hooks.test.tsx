// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  closeState,
  useUnsavedEditor,
  requestGuardedClose,
  useCloseGuard,
} from "./index";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke }));
it("registers synchronous editor state, tolerates StrictMode, and protects unexpected remount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  closeState.setReady(true);
  const host = document.createElement("div"),
    root = createRoot(host);
  let discard!: () => void;
  function Editor({ dirty, scope = "a" }: { dirty: boolean; scope?: string }) {
    discard = useUnsavedEditor(
      dirty ? "dirty" : "clean",
      scope,
      "changelistDescription",
    );
    return <input defaultValue="private text never reported" />;
  }
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <Editor dirty />
        </StrictMode>,
      ),
    );
    expect(closeState.snapshot()).toBe("dirty");
    expect(closeState.dirtyCategories()).toEqual(["changelistDescription"]);
    await act(async () => {
      discard();
      root.render(null);
    });
    expect(closeState.snapshot()).toBe("clean");
    await act(async () => root.render(<Editor dirty />));
    const discardPrevious = discard;
    await act(async () => root.render(<Editor dirty={false} scope="b" />));
    expect(closeState.snapshot()).toBe("dirty");
    expect(closeState.dirtyCategories()).toEqual(["changelistDescription"]);
    await act(async () => discardPrevious());
    expect(closeState.snapshot()).toBe("clean");
  } finally {
    await act(async () => root.unmount());
    closeState.setReady(false);
    vi.unstubAllGlobals();
  }
});
it.each(["window", "application"] as const)(
  "requests %s close without interpreting accepted as permission to destroy",
  async (scope) => {
    invoke.mockClear();
    invoke.mockResolvedValue({ accepted: false });
    expect(await requestGuardedClose(scope)).toEqual({ accepted: false });
    expect(invoke).toHaveBeenLastCalledWith("close_guard_request", { scope });
    invoke.mockResolvedValue({ accepted: true });
    expect(await requestGuardedClose(scope)).toEqual({ accepted: true });
    expect(
      invoke.mock.calls.every((call) => call[0] === "close_guard_request"),
    ).toBe(true);
  },
);

it("marks the shell ready without an invented host handshake", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invoke.mockClear();
  const { closeState, useCloseGuardReady } = await import("./index");
  closeState.setReady(false);
  const host = document.createElement("div"),
    root = createRoot(host);
  function Shell() {
    useCloseGuardReady();
    return <div className="app-shell" />;
  }
  try {
    await act(async () => root.render(<Shell />));
    expect(closeState.snapshot()).toBe("clean");
    // Readiness is local state: no command backs this hook, so none is sent.
    expect(invoke).not.toHaveBeenCalled();
    // The cleanup effect owns readiness, so unmounting must clear it again.
    await act(async () => root.unmount());
    expect(closeState.snapshot()).toBe("unknown");
  } finally {
    await act(async () => root.unmount());
    closeState.setReady(false);
    vi.unstubAllGlobals();
  }
});

it("uses the exact register/report IPC shape without a caller-supplied window label", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invoke.mockClear();
  invoke.mockImplementation(async (command) =>
    command === "close_guard_register"
      ? { generation: "42" }
      : { accepted: true },
  );
  const host = document.createElement("div"),
    root = createRoot(host);
  function Bridge() {
    useCloseGuard();
    return null;
  }
  try {
    await act(async () => root.render(<Bridge />));
    expect(invoke).toHaveBeenCalledWith("close_guard_register");
    await act(async () => closeState.setReady(true));
    const report = invoke.mock.calls.at(-1)!;
    expect(report[0]).toBe("close_guard_report");
    expect(Object.keys(report[1]).sort()).toEqual([
      "dirtyCategories",
      "generation",
      "probeId",
      "sequence",
      "state",
    ]);
    // No inbound probe channel exists, so every report is an unprompted push.
    expect(report[1]).toMatchObject({
      generation: "42",
      probeId: null,
      state: "clean",
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
