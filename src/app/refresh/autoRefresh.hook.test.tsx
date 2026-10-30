// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeInfo } from "../../shared/contracts";
import type { PageId } from "../panels";
import { useAutoRefresh } from "./autoRefresh";

const refetch = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../features/files/workspaceQueries", () => ({
  workspaceCache: { refetchQueries: refetch },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("applies interval changes immediately, disables timers at zero, and keeps manual refresh available", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const runtime = {
    activeProfileId: "fixture",
    contextGeneration: 1,
  } as RuntimeInfo;
  let refreshNow!: () => Promise<boolean>;
  function Probe({ minutes }: { minutes: number }) {
    const refresh = useAutoRefresh(
      runtime,
      "fixture:1",
      false,
      false,
      "pending",
      minutes,
    );
    refreshNow = refresh.refreshNow;
    return <output>{refresh.status.phase}</output>;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe minutes={5} />));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(refetch).not.toHaveBeenCalled();
    await act(async () => root.render(<Probe minutes={1} />));
    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(refetch).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(refetch).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Probe minutes={0} />));
    expect(host.textContent).toBe("paused");
    await act(async () => vi.advanceTimersByTimeAsync(600_000));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(refetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(await refreshNow()).toBe(true);
    });
    expect(refetch).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<Probe minutes={2} />));
    await act(async () => vi.advanceTimersByTimeAsync(119_999));
    expect(refetch).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(refetch).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps one five-minute clock across tab switches and refreshes the latest tab", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const runtime = {
    activeProfileId: "fixture",
    contextGeneration: 1,
  } as RuntimeInfo;
  function Probe({ page }: { page: PageId }) {
    useAutoRefresh(runtime, "fixture:1", false, false, page);
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  const pending = vi.fn();
  const submitted = vi.fn();
  window.addEventListener("p4deck:pending-refresh", pending);
  window.addEventListener("p4deck:submitted-refresh", submitted);
  try {
    await act(async () => root.render(<Probe page="pending" />));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await act(async () => root.render(<Probe page="submitted" />));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(refetch).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(240_000));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(pending).not.toHaveBeenCalled();
    await act(async () => root.render(<Probe page="pending" />));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => vi.advanceTimersByTimeAsync(299_999));
    expect(refetch).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(pending).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    window.removeEventListener("p4deck:pending-refresh", pending);
    window.removeEventListener("p4deck:submitted-refresh", submitted);
  }
});
