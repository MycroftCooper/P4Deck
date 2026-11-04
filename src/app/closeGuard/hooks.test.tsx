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
const events = vi.hoisted(() => ({
  handler: undefined as
    | undefined
    | ((event: { payload: { generation: string; probeId: string } }) => void),
  stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name, handler) => {
    events.handler = handler;
    return events.stop;
  }),
}));
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

it("acknowledges the painted shell so the host drops its fallback caption bar", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invoke.mockClear();
  invoke.mockImplementation(async (command) =>
    command === "close_guard_register" ? { generation: "7" } : true,
  );
  const { useCloseGuardReady } = await import("./index");
  const host = document.createElement("div"),
    root = createRoot(host);
  function Shell() {
    useCloseGuardReady();
    return <div className="app-shell" />;
  }
  try {
    await act(async () => root.render(<Shell />));
    expect(invoke).toHaveBeenCalledWith("shell_recovery_connected");
    // A rejected acknowledgement must never break the shell.
    invoke.mockRejectedValueOnce(new Error("no such window state"));
    await act(async () => root.render(<Shell key="again" />));
    expect(attemptedShellAck(invoke)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

function attemptedShellAck(mock: typeof invoke) {
  return mock.mock.calls.some((call) => call[0] === "shell_recovery_connected");
}

it("uses the exact register/report/probe IPC shape without a caller-supplied window label", async () => {
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
    await act(async () =>
      events.handler!({ payload: { generation: "42", probeId: "probe-1" } }),
    );
    const report = invoke.mock.calls.at(-1)!;
    expect(report[0]).toBe("close_guard_report");
    expect(Object.keys(report[1]).sort()).toEqual([
      "dirtyCategories",
      "generation",
      "probeId",
      "sequence",
      "state",
    ]);
    expect(report[1]).toMatchObject({
      generation: "42",
      probeId: "probe-1",
      state: "unknown",
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
  expect(events.stop).toHaveBeenCalled();
});
